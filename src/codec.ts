/**
 * Audio and packet conversion. Free of side effects, so this layer can be used on its own.
 */

/** Convert Float32 PCM in the -1..1 range to Int16 PCM. */
export function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

/** Concatenate two Int16Arrays. */
export function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const c = new Int16Array(a.length + b.length);
  c.set(a, 0);
  c.set(b, a.length);
  return c;
}

/**
 * Convert Int16 PCM to a big-endian byte sequence.
 *
 * AmiVoice's default audio format `MSB16K` means Most Significant Byte first —
 * big-endian at 16 kHz. Getting this backwards turns speech into noise.
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

/**
 * Convert Int16 PCM to a little-endian byte sequence, for the `LSB…` formats.
 */
export function int16ToLittleEndianBytes(int16: Int16Array): Uint8Array {
  const out = new Uint8Array(int16.length * 2);
  let j = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] ?? 0;
    out[j++] = v & 0xff;
    out[j++] = (v >> 8) & 0xff;
  }
  return out;
}

export type ByteOrder = "big" | "little";

/**
 * The byte order a headerless PCM `codec` expects: `MSB8K` … `MSB48K` are
 * big-endian, `LSB8K` … `LSB48K` little-endian.
 *
 * Returns `undefined` for anything else — `MULAW`, `ALAW`, and the header formats
 * such as `16K` — because those are not 16-bit PCM and this client cannot produce
 * them from Float32 samples.
 */
export function pcmByteOrder(codec: string): ByteOrder | undefined {
  if (/^MSB(8|11|16|22|32|44|48)K$/.test(codec)) return "big";
  if (/^LSB(8|11|16|22|32|44|48)K$/.test(codec)) return "little";
  return undefined;
}

/** Resample from the input rate to the output rate by linear interpolation. */
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

/**
 * Build an audio packet for the `p` command. The first byte is 'p'.
 *
 * `byteOrder` must match the codec named in the `s` command — see `pcmByteOrder`.
 * Defaults to big-endian, for the default `MSB16K`.
 */
export function buildAudioPacket(
  int16: Int16Array,
  byteOrder: ByteOrder = "big",
): Uint8Array {
  const bytes =
    byteOrder === "little"
      ? int16ToLittleEndianBytes(int16)
      : int16ToBigEndianBytes(int16);
  const frame = new Uint8Array(1 + bytes.length);
  frame[0] = 0x70; // 'p'
  frame.set(bytes, 1);
  return frame;
}

/** Split an incoming packet into its leading tag character and its body. */
export function splitPacket(data: string): { body: string; tag: string } {
  const tag = data.slice(0, 1);
  // The separating space may or may not be present. A response with no body, such
  // as 'e', arrives as a single character.
  const body =
    data.length >= 2 && data[1] === " " ? data.slice(2) : data.slice(1);
  return { body, tag };
}

/**
 * Extract the recognized text from the body of a `U` or `A` event.
 *
 * The body is JSON, but one carrying a `code` is an error rather than a result, so
 * it is dropped. A body that is not a JSON object is not a result either and gives
 * `undefined`; use `isResultBody` to tell it apart from an empty result.
 */
export function parseResultBody(body: string): string | undefined {
  const obj = parseJsonObject(body);
  if (!obj || obj.code) return undefined;
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

/**
 * Whether a `U` or `A` body is a JSON object, as every result is. Anything else is
 * a malformed or error body, not recognized speech.
 */
export function isResultBody(body: string): boolean {
  return parseJsonObject(body) !== undefined;
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(body);
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export type StartCommandParams = {
  /** Audio format. Defaults to `MSB16K`, big-endian at 16 kHz. */
  codec?: string;
  /** The authentication token for the connection. */
  token: string;
  /** Recognition engine. Defaults to the general-purpose `-a-general`. */
  grammar?: string;
  /** Personal dictionary identifier. */
  profileId?: string;
  /** Registered words. Build this with `formatProfileWords`. */
  profileWords?: string;
  /** How often interim results are sent back. Defaults to 1000 ms. */
  resultUpdatedIntervalMs?: number;
  /** Any other parameters, appended verbatim as `key=value`. */
  extra?: Record<string, number | string>;
};

/** Build the `s` command string. */
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
  // Words can contain spaces, so always quote them. Unquoted, everything after the
  // first word is read as a separate parameter.
  if (profileWords) params.push(`profileWords="${profileWords}"`);
  for (const [key, value] of Object.entries(extra ?? {})) {
    params.push(`${key}=${value}`);
  }
  return `s ${codec} ${grammar} ${params.join(" ")}`;
}

/** Build registered words into the single line the `s` command carries. */
export function formatProfileWords(
  words: readonly { spoken: string; wordClass?: string; written: string }[],
): string {
  return words
    .map(({ spoken, wordClass, written }) =>
      [written, spoken, wordClass].filter(Boolean).join(" "),
    )
    .join("|");
}
