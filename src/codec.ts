/**
 * 音声とパケットの変換。副作用を持たないので、この層だけを単体で使うこともできる。
 */

/** Float32 PCM（-1〜1）を Int16 PCM に変換する。 */
export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

/** 2 つの Int16Array を連結する。 */
export function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const c = new Int16Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

/**
 * Int16 PCM をビッグエンディアンのバイト列に変換する。
 *
 * AmiVoice の既定の音声形式 `MSB16K` は Most Significant Byte first、つまり
 * ビッグエンディアンの 16 kHz。ここを取り違えると雑音として認識される。
 */
export function int16ToBigEndianBytes(int16: Int16Array): Uint8Array {
  const out = new Uint8Array(int16.length * 2);
  let j = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] ?? 0;
    out[j++] = (v >> 8) & 0xff;
    out[j++] = v & 0xff;
  }
  return out;
}

/** 入力サンプリングレートから出力レートへ線形補間でリサンプルする。 */
export function resample(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
    const t = srcIndex - srcIndexFloor;
    const a = input[srcIndexFloor] ?? 0;
    const b = input[srcIndexCeil] ?? 0;
    output[i] = a * (1 - t) + b * t;
  }
  return output;
}

/** `p` コマンドの音声パケットを組み立てる（先頭 1 バイトが 'p'）。 */
export function buildAudioPacket(int16: Int16Array): Uint8Array {
  const bytes = int16ToBigEndianBytes(int16);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = 0x70; // 'p'
  frame.set(bytes, 1);
  return frame;
}

/** 受信パケットを、先頭 1 文字のタグと本体に分ける。 */
export function splitPacket(data: string): { body: string; tag: string } {
  const tag = data.slice(0, 1);
  // 区切りの空白は在ることも無いこともある。'e' のように本体を持たない応答は
  // 1 文字だけで届く。
  const body = data.length >= 2 && data[1] === " " ? data.slice(2) : data.slice(1);
  return { body, tag };
}

/**
 * `U` / `A` イベントの本体から認識結果のテキストを取り出す。
 *
 * 本体は JSON だが、`code` を持つものは認識結果ではなくエラーなので落とす。
 * JSON として読めない本体も届くことがあるため、その場合は制御文字だけ剥がして返す。
 */
export function parseResultBody(body: string): string | undefined {
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      if (obj.code) return undefined;
      if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
      const results = obj.results;
      if (Array.isArray(results)) {
        const first: unknown = results[0];
        if (
          first &&
          typeof first === "object" &&
          "text" in first &&
          typeof (first as { text: unknown }).text === "string" &&
          (first as { text: string }).text.trim()
        ) {
          return (first as { text: string }).text;
        }
      }
      return undefined;
    }
  } catch {
    // JSON でない本体は下で扱う
  }
  let text = body;
  if (text.startsWith("\x01\x01\x01\x01\x01")) text = text.slice(5);
  return text || undefined;
}

export type StartCommandParams = {
  /** 音声形式。既定は 16 kHz ビッグエンディアンの `MSB16K`。 */
  codec?: string;
  /** 接続の認証トークン。 */
  token: string;
  /** 認識エンジン。既定は汎用の `-a-general`。 */
  grammar?: string;
  /** マイ辞書の識別子。 */
  profileId?: string;
  /** 単語登録。`formatProfileWords` で組み立てられる。 */
  profileWords?: string;
  /** 途中経過を返す間隔。既定 1000 ミリ秒。 */
  resultUpdatedIntervalMs?: number;
  /** 上記以外のパラメータ。`key=value` としてそのまま並べる。 */
  extra?: Record<string, number | string>;
};

/** `s` コマンドの文字列を組み立てる。 */
export function buildStartCommand({
  codec = "MSB16K",
  extra,
  grammar = "-a-general",
  profileId,
  profileWords,
  resultUpdatedIntervalMs = 1000,
  token,
}: StartCommandParams): string {
  const params: string[] = [
    `resultUpdatedInterval=${resultUpdatedIntervalMs}`,
    `authorization=${token}`,
  ];
  if (profileId) params.push(`profileId=${profileId}`);
  // 単語は空白を含みうるので必ず引用符で囲む。囲まずに送ると 2 語目以降が
  // 別のパラメータとして読まれる。
  if (profileWords) params.push(`profileWords="${profileWords}"`);
  for (const [key, value] of Object.entries(extra ?? {})) {
    params.push(`${key}=${value}`);
  }
  return `s ${codec} ${grammar} ${params.join(" ")}`;
}

/** 単語登録を `s` コマンドに載る 1 行へ組み立てる。 */
export function formatProfileWords(
  words: readonly { spoken: string; wordClass?: string; written: string }[],
): string {
  return words
    .map(({ spoken, wordClass, written }) =>
      [written, spoken, wordClass].filter(Boolean).join(" "),
    )
    .join("|");
}
