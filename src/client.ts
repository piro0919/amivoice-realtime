import {
  buildAudioPacket,
  buildStartCommand,
  concatInt16,
  floatToInt16,
  parseResultBody,
  resample,
  splitPacket,
  type StartCommandParams,
} from "./codec.js";

const DEFAULT_URL = "wss://acp-api.amivoice.com/v1/";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_SEND_INTERVAL_MS = 100;

/** `WebSocket` のうち、この実装が使う部分だけ。 */
export type WebSocketLike = {
  close(): void;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: ((event: unknown) => void) | null;
  readyState: number;
  send(data: ArrayBufferView | string): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ReconnectOptions = {
  growFactor?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  minDelayMs?: number;
};

export type AmiVoiceRealtimeOptions = {
  /**
   * 認証トークン、またはそれを返す関数。
   *
   * トークンはワンタイムで寿命が短い。関数を渡すと、接続のたびに呼ばれるので、
   * 再接続でも新しいトークンを取れる。文字列で渡すと 1 回しか使えない。
   *
   * **資格情報（sid / spw）をブラウザに置かないこと。** トークンの発行は
   * `amivoice-realtime/server` を使ってサーバー側で行う。
   */
  token: (() => Promise<string> | string) | string;
  /** 音声形式。既定は `MSB16K`。変えるなら `sampleRate` も併せて変える。 */
  codec?: string;
  /** 認識エンジン。既定は `-a-general`。 */
  grammar?: string;
  /** 送出をやめて接続を切るまでの、`e` の応答の待ち時間。既定 3000 ミリ秒。 */
  finishTimeoutMs?: number;
  onClose?: () => void;
  onError?: (error: Error) => void;
  /** 確定した認識結果。1 発話ごとに呼ばれる。 */
  onFinal?: (text: string) => void;
  onOpen?: () => void;
  /** 途中経過。同じ発話について何度も呼ばれ、そのたび全文が渡る。 */
  onPartial?: (text: string) => void;
  profileId?: string;
  profileWords?: string;
  /** 再接続の設定。`false` で切る。既定は最大 5 回。 */
  reconnect?: ReconnectOptions | false;
  resultUpdatedIntervalMs?: number;
  /** 送出する音声のサンプリングレート。既定 16000。`codec` に合わせる。 */
  sampleRate?: number;
  /** 1 パケットに載せる音声の長さ。既定 100 ミリ秒。 */
  sendIntervalMs?: number;
  /** `s` コマンドに足すパラメータ。 */
  startParams?: StartCommandParams["extra"];
  url?: string;
  /**
   * `WebSocket` の実装。既定はグローバルのもの。
   * Node では `ws` を渡す: `webSocket: (url) => new WebSocket(url)`
   */
  webSocket?: WebSocketFactory;
};

export type ConnectionState = "closed" | "closing" | "connecting" | "open";

const OPEN = 1;

function defaultWebSocketFactory(url: string): WebSocketLike {
  const impl = (globalThis as { WebSocket?: new (url: string) => unknown })
    .WebSocket;
  if (!impl) {
    throw new Error(
      "WebSocket is not available. Pass the `webSocket` option (in Node: `webSocket: (url) => new WebSocket(url)` from the `ws` package).",
    );
  }
  return new impl(url) as WebSocketLike;
}

/**
 * AmiVoice のリアルタイム音声認識に、音声を送って結果を受け取る。
 *
 * マイクの取得はこの実装の責務ではない。`write()` に Float32 のサンプルを渡す。
 * どこから取るかは呼び出し側が決める。
 */
export class AmiVoiceRealtimeClient {
  private buffer: Int16Array = new Int16Array(0);
  private closedByUser = false;
  private finishTimer: null | ReturnType<typeof setTimeout> = null;
  private readonly options: AmiVoiceRealtimeOptions;
  private retries = 0;
  private state: ConnectionState = "closed";
  private waitingForEnd = false;
  private ws: null | WebSocketLike = null;

  public constructor(options: AmiVoiceRealtimeOptions) {
    this.options = options;
  }

  /** 今の接続の状態。 */
  public get connectionState(): ConnectionState {
    return this.state;
  }

  /** 接続して認識を始める。`onOpen` が呼ばれた時点から音声を送れる。 */
  public async start(): Promise<void> {
    if (this.state === "connecting" || this.state === "open") return;
    this.closedByUser = false;
    this.retries = 0;
    this.buffer = new Int16Array(0);
    await this.connect();
  }

  /**
   * 音声を送る。`samples` は 1ch の Float32（-1〜1）。
   *
   * 送出レートへのリサンプルと、パケットへの詰め替えはこの中で行う。
   * 接続していない間に渡した音声は捨てる。溜めて後から送ると、認識の側では
   * 過去の音声が今の発話として届くことになる。
   */
  public write(samples: Float32Array, sampleRate: number): void {
    if (this.state !== "open" || !this.ws) return;
    const target = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const resampled = resample(samples, sampleRate, target);
    this.buffer = concatInt16(this.buffer, floatToInt16(resampled));

    const intervalMs = this.options.sendIntervalMs ?? DEFAULT_SEND_INTERVAL_MS;
    const samplesPerPacket = Math.floor((target * intervalMs) / 1000);
    while (this.buffer.length >= samplesPerPacket) {
      const chunk = this.buffer.slice(0, samplesPerPacket);
      this.buffer = this.buffer.slice(samplesPerPacket);
      if (this.ws.readyState !== OPEN) return;
      this.ws.send(buildAudioPacket(chunk));
    }
  }

  /**
   * 認識を終える。`e` を送り、応答を待ってから接続を切る。
   *
   * 待つのは、最後の発話の確定結果が `e` の前に届くため。すぐ切ると言い終わりが落ちる。
   */
  public async finish(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.closedByUser = true;
    this.state = "closing";
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) {
      this.teardown();
      return;
    }
    this.waitingForEnd = true;
    try {
      ws.send("e");
    } catch {
      this.teardown();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeoutMs = this.options.finishTimeoutMs ?? 3000;
      this.finishTimer = setTimeout(() => {
        this.teardown();
        resolve();
      }, timeoutMs);
      this.onFinished = () => {
        this.teardown();
        resolve();
      };
    });
  }

  /** すぐ切る。確定していない発話は捨てる。 */
  public close(): void {
    this.closedByUser = true;
    this.teardown();
  }

  private onFinished: (() => void) | null = null;

  private async connect(): Promise<void> {
    this.state = "connecting";
    let token: string;
    try {
      token =
        typeof this.options.token === "function"
          ? await this.options.token()
          : this.options.token;
    } catch (error) {
      this.state = "closed";
      this.emitError(error);
      return;
    }
    if (this.closedByUser) {
      this.state = "closed";
      return;
    }

    const factory = this.options.webSocket ?? defaultWebSocketFactory;
    let ws: WebSocketLike;
    try {
      ws = factory(this.options.url ?? DEFAULT_URL);
    } catch (error) {
      this.state = "closed";
      this.emitError(error);
      return;
    }
    this.ws = ws;

    ws.onopen = (): void => {
      const command = buildStartCommand({
        codec: this.options.codec,
        extra: this.options.startParams,
        grammar: this.options.grammar,
        profileId: this.options.profileId,
        profileWords: this.options.profileWords,
        resultUpdatedIntervalMs: this.options.resultUpdatedIntervalMs,
        token,
      });
      ws.send(command);
    };
    ws.onmessage = (event): void => {
      this.handleMessage(String(event.data));
    };
    ws.onerror = (): void => {
      this.emitError(new Error("AmiVoice WebSocket error"));
    };
    ws.onclose = (): void => {
      this.handleClose();
    };
  }

  private handleMessage(data: string): void {
    const { body, tag } = splitPacket(data);

    // s / p / e の応答は、本体が空なら成功、本体があればエラーメッセージ。
    // 認識が始まっていないことに気づけるのはここだけなので、必ず拾う。
    if (tag === "s" || tag === "p") {
      if (body.trim()) {
        this.emitError(new Error(`AmiVoice ${tag} command failed: ${body}`));
        return;
      }
      if (tag === "s") {
        this.state = "open";
        this.retries = 0;
        this.options.onOpen?.();
      }
      return;
    }
    if (tag === "e") {
      if (body.trim()) {
        this.emitError(new Error(`AmiVoice e command failed: ${body}`));
      }
      if (this.waitingForEnd) {
        this.waitingForEnd = false;
        this.onFinished?.();
      }
      return;
    }
    if (tag === "U") {
      const text = parseResultBody(body);
      if (text) this.options.onPartial?.(text);
      return;
    }
    if (tag === "A") {
      const text = parseResultBody(body);
      if (text) this.options.onFinal?.(text);
    }
  }

  private handleClose(): void {
    this.ws = null;
    if (this.closedByUser || this.state === "closing") {
      this.state = "closed";
      this.options.onClose?.();
      return;
    }
    const reconnect = this.options.reconnect;
    if (reconnect === false) {
      this.state = "closed";
      this.options.onClose?.();
      return;
    }
    const maxRetries = reconnect?.maxRetries ?? 5;
    if (this.retries >= maxRetries) {
      this.state = "closed";
      this.options.onClose?.();
      return;
    }
    const minDelay = reconnect?.minDelayMs ?? 1000;
    const maxDelay = reconnect?.maxDelayMs ?? 10_000;
    const growFactor = reconnect?.growFactor ?? 1.3;
    const delay = Math.min(maxDelay, minDelay * growFactor ** this.retries);
    this.retries += 1;
    this.state = "connecting";
    setTimeout(() => {
      if (this.closedByUser) return;
      void this.connect();
    }, delay);
  }

  private emitError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private teardown(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.onFinished = null;
    this.waitingForEnd = false;
    this.buffer = new Int16Array(0);
    const ws = this.ws;
    this.ws = null;
    this.state = "closed";
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        // 既に切れている
      }
    }
    this.options.onClose?.();
  }
}

/** クライアントを作って接続まで済ませる。 */
export async function createAmiVoiceRealtimeClient(
  options: AmiVoiceRealtimeOptions,
): Promise<AmiVoiceRealtimeClient> {
  const client = new AmiVoiceRealtimeClient(options);
  await client.start();
  return client;
}
