import {
  type ByteOrder,
  buildAudioPacket,
  buildStartCommand,
  concatInt16,
  floatToInt16,
  isResultBody,
  parseResultBody,
  pcmByteOrder,
  resample,
  type StartCommandParams,
  splitPacket,
} from "./codec";

const DEFAULT_URL = "wss://acp-api.amivoice.com/v1/";
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_SEND_INTERVAL_MS = 100;

/** The part of `WebSocket` this implementation uses. */
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
   * The authentication token, or a function returning one.
   *
   * Tokens are short-lived: one can be used for any number of connections until it
   * expires, and none after. A function is called on every connect, so reconnects
   * get a token that is still valid. A plain string stops working once it expires.
   *
   * **Never put the credentials (sid / spw) in the browser.** Issue tokens on the
   * server with `amivoice-realtime/server`.
   */
  token: (() => Promise<string> | string) | string;
  /**
   * Audio format. Defaults to `MSB16K`. Headerless 16-bit PCM only: `MSB8K` …
   * `MSB48K` go out big-endian, `LSB8K` … `LSB48K` little-endian. Anything else
   * makes `start()` reject. Change `sampleRate` to match the rate in the name.
   */
  codec?: string;
  /** Recognition engine. Defaults to `-a-general`. */
  grammar?: string;
  /** How long to wait for the `e` response before closing. Defaults to 3000 ms. */
  finishTimeoutMs?: number;
  onClose?: () => void;
  onError?: (error: Error) => void;
  /** A final result. Called once per utterance. */
  onFinal?: (text: string) => void;
  onOpen?: () => void;
  /** An interim result. Called repeatedly for one utterance, each time with the full text. */
  onPartial?: (text: string) => void;
  profileId?: string;
  profileWords?: string;
  /**
   * Reconnect settings. `false` disables it. Defaults to at most 5 attempts.
   * A rejected `s` command (failed authentication, an unknown codec or engine) is
   * never retried: the same command would be rejected again.
   */
  reconnect?: ReconnectOptions | false;
  resultUpdatedIntervalMs?: number;
  /** Sample rate of the audio sent. Defaults to 16000. Match it to `codec`. */
  sampleRate?: number;
  /** How much audio each packet carries. Defaults to 100 ms. */
  sendIntervalMs?: number;
  /** Extra parameters appended to the `s` command. */
  startParams?: StartCommandParams["extra"];
  url?: string;
  /**
   * The `WebSocket` implementation. Defaults to the global one.
   * In Node, pass `ws`: `webSocket: (url) => new WebSocket(url)`
   */
  webSocket?: WebSocketFactory;
};

export type ConnectionState = "closed" | "closing" | "connecting" | "open";

const OPEN = 1;

type PendingStart = {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
};

function abortError(): Error {
  const error = new Error("The client was closed before recognition started");
  error.name = "AbortError";
  return error;
}

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
 * Sends audio to AmiVoice realtime speech recognition and receives the results.
 *
 * Acquiring the microphone is not this class's job. Hand `write()` Float32 samples;
 * where they come from is the caller's decision.
 */
export class AmiVoiceRealtimeClient {
  private buffer: Int16Array = new Int16Array(0);
  private byteOrder: ByteOrder = "big";
  private closedByUser = false;
  private finishTimer: null | ReturnType<typeof setTimeout> = null;
  private readonly options: AmiVoiceRealtimeOptions;
  private retries = 0;
  /** Settles the promise `start()` returned, once recognition starts or fails. */
  private pendingStart: null | PendingStart = null;
  private state: ConnectionState = "closed";
  private waitingForEnd = false;
  private ws: null | WebSocketLike = null;

  public constructor(options: AmiVoiceRealtimeOptions) {
    this.options = options;
  }

  /** The current connection state. */
  public get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Connect and start recognizing.
   *
   * Resolves once the `s` command succeeds — the same moment `onOpen` fires — so
   * audio can be sent right after. Rejects when recognition cannot start: the
   * token could not be obtained, the codec is not one this client can encode, the
   * `s` command was rejected (e.g. authentication failed), the connection closed
   * and reconnecting gave up, or `close()` / `finish()` was called first (an
   * `AbortError`). Each failure is also passed to `onError`, except the abort.
   */
  public start(): Promise<void> {
    if (this.state === "open") return Promise.resolve();
    // Already connecting, or reconnecting: wait for that attempt.
    if (this.state === "connecting") return this.waitForStart().promise;
    this.closedByUser = false;
    this.retries = 0;
    this.buffer = new Int16Array(0);

    const codec = this.options.codec ?? "MSB16K";
    const byteOrder = pcmByteOrder(codec);
    if (!byteOrder) {
      const error = new Error(
        `Unsupported codec ${codec}: this client sends 16-bit PCM, so use MSB8K … MSB48K or LSB8K … LSB48K`,
      );
      this.emitError(error);
      return Promise.reject(error);
    }
    this.byteOrder = byteOrder;

    const { promise } = this.waitForStart();
    void this.connect();
    return promise;
  }

  private waitForStart(): PendingStart {
    if (this.pendingStart) return this.pendingStart;
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.pendingStart = { promise, reject, resolve };
    return this.pendingStart;
  }

  /**
   * Send audio. `samples` is single-channel Float32 in the -1..1 range.
   *
   * Resampling to the send rate and packing into packets happen here.
   *
   * Audio handed over while disconnected is discarded. Buffering it would deliver
   * past audio as if it were the current utterance.
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
      this.ws.send(buildAudioPacket(chunk, this.byteOrder));
    }
  }

  /**
   * Finish recognizing. Sends `e`, waits for the response, then closes.
   *
   * The wait matters because the final result of the last utterance arrives before
   * `e`. Closing immediately drops the end of what was said.
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

  /** Close immediately, discarding anything not yet finalized. */
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
      this.failStart(this.emitError(error));
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
      this.failStart(this.emitError(error));
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

    // For s / p / e the response means success when the body is empty and carries an
    // error message otherwise. This is the only place recognition failing to start
    // becomes visible, so never skip it.
    if (tag === "s" || tag === "p") {
      if (body.trim()) {
        const error = this.emitError(
          new Error(`AmiVoice ${tag} command failed: ${body}`),
        );
        // A rejected s command — failed authentication above all — is rejected
        // again on every retry, and each retry spends a token. Stop here.
        if (tag === "s") this.stop(error);
        return;
      }
      if (tag === "s") {
        this.state = "open";
        this.retries = 0;
        this.pendingStart?.resolve();
        this.pendingStart = null;
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
    if ((tag === "U" || tag === "A") && !isResultBody(body)) {
      // Every result is a JSON object. Anything else is an error or a broken
      // packet, and must not reach the caller as recognized speech.
      this.emitError(
        new Error(
          `AmiVoice ${tag} event carried a body that is not a result: ${body}`,
        ),
      );
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
    const maxRetries = reconnect === false ? 0 : (reconnect?.maxRetries ?? 5);
    if (this.retries >= maxRetries) {
      this.state = "closed";
      this.failStart(
        new Error("AmiVoice connection closed before recognition started"),
      );
      this.options.onClose?.();
      return;
    }
    const settings = reconnect || {};
    const minDelay = settings.minDelayMs ?? 1000;
    const maxDelay = settings.maxDelayMs ?? 10_000;
    const growFactor = settings.growFactor ?? 1.3;
    const delay = Math.min(maxDelay, minDelay * growFactor ** this.retries);
    this.retries += 1;
    this.state = "connecting";
    setTimeout(() => {
      if (this.closedByUser) return;
      void this.connect();
    }, delay);
  }

  /** Report an error to `onError`, and hand it back as an `Error`. */
  private emitError(error: unknown): Error {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
    return normalized;
  }

  /** Reject the promise `start()` returned, if it is still waiting. */
  private failStart(error: Error): void {
    this.pendingStart?.reject(error);
    this.pendingStart = null;
  }

  /** Close for good after a failure that retrying would not fix. */
  private stop(error: Error): void {
    this.closedByUser = true;
    this.failStart(error);
    this.teardown();
  }

  private teardown(): void {
    this.failStart(abortError());
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
        // already closed
      }
    }
    this.options.onClose?.();
  }
}

/** Create a client and connect it. */
export async function createAmiVoiceRealtimeClient(
  options: AmiVoiceRealtimeOptions,
): Promise<AmiVoiceRealtimeClient> {
  const client = new AmiVoiceRealtimeClient(options);
  await client.start();
  return client;
}
