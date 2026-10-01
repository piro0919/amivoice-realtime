import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmiVoiceRealtimeClient, type WebSocketLike } from "../src/client";

const OPEN = 1;
const CLOSED = 3;

/** A test WebSocket. Records what was sent and can pretend things arrived. */
class FakeSocket implements WebSocketLike {
  public static instances: FakeSocket[] = [];
  public onclose: ((event: unknown) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onopen: ((event: unknown) => void) | null = null;
  public readyState = OPEN;
  public sent: (ArrayBufferView | string)[] = [];

  public constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  public send(data: ArrayBufferView | string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = CLOSED;
    this.onclose?.({});
  }

  /** Pretend the connection opened. */
  public open(): void {
    this.onopen?.({});
  }

  /** Pretend a packet arrived from the server. */
  public receive(data: string): void {
    this.onmessage?.({ data });
  }

  public get texts(): string[] {
    return this.sent.filter((d): d is string => typeof d === "string");
  }

  public get binaries(): ArrayBufferView[] {
    return this.sent.filter((d): d is ArrayBufferView => typeof d !== "string");
  }
}

function makeClient(
  overrides: Partial<
    ConstructorParameters<typeof AmiVoiceRealtimeClient>[0]
  > = {},
): AmiVoiceRealtimeClient {
  return new AmiVoiceRealtimeClient({
    token: "TOKEN",
    webSocket: (url) => new FakeSocket(url),
    ...overrides,
  });
}

function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket was created");
  return socket;
}

/** Connect and get as far as a successful `s` response. */
async function started(
  overrides: Partial<
    ConstructorParameters<typeof AmiVoiceRealtimeClient>[0]
  > = {},
): Promise<{ client: AmiVoiceRealtimeClient; socket: FakeSocket }> {
  const client = makeClient(overrides);
  const starting = client.start();
  const socket = latest();
  socket.open();
  socket.receive("s");
  await starting;
  return { client, socket };
}

/** Let a token function's promise settle so the socket gets created. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("start", () => {
  it("connects to the default endpoint", async () => {
    await started();
    expect(latest().url).toBe("wss://acp-api.amivoice.com/v1/");
  });

  it("sends the s command once the connection opens", async () => {
    const { socket } = await started({ profileId: "acme" });
    expect(socket.texts[0]).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=TOKEN profileId=acme",
    );
  });

  it("fetches a fresh token on every connect", async () => {
    const token = vi.fn().mockResolvedValue("FRESH");
    const client = makeClient({ token });
    void client.start().catch(() => {});
    await settle();
    latest().open();
    expect(token).toHaveBeenCalledTimes(1);
    expect(latest().texts[0]).toContain("authorization=FRESH");
  });

  it("is not open until the s response succeeds", async () => {
    const onOpen = vi.fn();
    const client = makeClient({ onOpen });
    let resolved = false;
    const starting = client.start().then(() => {
      resolved = true;
    });
    latest().open();
    await settle();
    expect(onOpen).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    expect(client.connectionState).toBe("connecting");

    latest().receive("s");
    await starting;
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(client.connectionState).toBe("open");
  });

  it("rejects when the token cannot be obtained", async () => {
    const onError = vi.fn();
    const client = makeClient({
      onError,
      token: () => Promise.reject(new Error("no token")),
    });
    await expect(client.start()).rejects.toThrow("no token");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "no token" }),
    );
  });

  it("rejects when closed before recognition starts", async () => {
    const client = makeClient();
    const starting = client.start();
    client.close();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the connection closes and reconnecting is off", async () => {
    const client = makeClient({ reconnect: false });
    const starting = client.start();
    latest().close();
    await expect(starting).rejects.toThrow(
      "AmiVoice connection closed before recognition started",
    );
  });

  it("returns the pending attempt when called again while connecting", async () => {
    const client = makeClient();
    const first = client.start();
    const second = client.start();
    expect(FakeSocket.instances).toHaveLength(1);
    latest().open();
    latest().receive("s");
    await Promise.all([first, second]);
  });

  it("rejects a codec it cannot encode", async () => {
    const onError = vi.fn();
    const client = makeClient({ codec: "MULAW", onError });
    await expect(client.start()).rejects.toThrow("Unsupported codec MULAW");
    expect(FakeSocket.instances).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
  });
});

describe("codec", () => {
  it("sends big-endian audio for MSB16K", async () => {
    const { client, socket } = await started({ sendIntervalMs: 1 });
    // 16 samples is 1 ms at 16 kHz. 0.5 becomes 0x3fff.
    client.write(new Float32Array(16).fill(0.5), 16000);
    const packet = socket.binaries[0] as Uint8Array;
    expect([packet[1], packet[2]]).toEqual([0x3f, 0xff]);
  });

  it("sends little-endian audio for LSB16K", async () => {
    const { client, socket } = await started({
      codec: "LSB16K",
      sendIntervalMs: 1,
    });
    client.write(new Float32Array(16).fill(0.5), 16000);
    const packet = socket.binaries[0] as Uint8Array;
    expect([packet[1], packet[2]]).toEqual([0xff, 0x3f]);
    expect(socket.texts[0]).toMatch(/^s LSB16K /);
  });
});

describe("results", () => {
  it("delivers U as an interim result", async () => {
    const onPartial = vi.fn();
    const { socket } = await started({ onPartial });
    socket.receive('U {"text":"おは"}');
    expect(onPartial).toHaveBeenCalledWith("おは");
  });

  it("delivers A as a final result", async () => {
    const onFinal = vi.fn();
    const { socket } = await started({ onFinal });
    socket.receive('A {"text":"おはようございます"}');
    expect(onFinal).toHaveBeenCalledWith("おはようございます");
  });

  it("does not deliver an error body as a result", async () => {
    const onFinal = vi.fn();
    const { socket } = await started({ onFinal });
    socket.receive('A {"code":"o","message":"error"}');
    expect(onFinal).not.toHaveBeenCalled();
  });

  it("reports a body that is not JSON as an error, not as speech", async () => {
    const onFinal = vi.fn();
    const onPartial = vi.fn();
    const onError = vi.fn();
    const { socket } = await started({ onError, onFinal, onPartial });
    socket.receive("A recognizer crashed");
    socket.receive("U \x01\x01\x01\x01\x01ねこ");
    expect(onFinal).not.toHaveBeenCalled();
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "AmiVoice A event carried a body that is not a result: recognizer crashed",
      }),
    );
  });
});

describe("command failure responses", () => {
  it("treats a bodied s response as an error", async () => {
    const onError = vi.fn();
    const onOpen = vi.fn();
    const client = makeClient({ onError, onOpen });
    const starting = client.start();
    latest().open();
    latest().receive("s Authentication failed");

    await expect(starting).rejects.toThrow(
      "AmiVoice s command failed: Authentication failed",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "AmiVoice s command failed: Authentication failed",
      }),
    );
    // Recognition never started. Reporting open here would leave the caller
    // waiting for results while the audio it sends is thrown away.
    expect(onOpen).not.toHaveBeenCalled();
    expect(client.connectionState).toBe("closed");
  });

  it("does not reconnect after a rejected s command", async () => {
    vi.useFakeTimers();
    try {
      const token = vi.fn().mockReturnValue("BAD");
      const onClose = vi.fn();
      const client = makeClient({ onClose, token });
      const starting = client.start().catch(() => {});
      await settle();
      latest().open();
      latest().receive("s Authentication failed");
      await starting;
      // The server hangs up after the failure; that must not start a retry.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(token).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after a rejected s command on a reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = await started();
      socket.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(2);

      latest().open();
      latest().receive("s Authentication failed");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a bodied p response as an error", async () => {
    const onError = vi.fn();
    const { socket } = await started({ onError });
    socket.receive("p something went wrong");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "AmiVoice p command failed: something went wrong",
      }),
    );
  });
});

describe("write", () => {
  it("sends only once 100 ms has accumulated", async () => {
    const { client, socket } = await started();
    // 100 ms at 16 kHz is 1600 samples. Nothing goes out before that.
    client.write(new Float32Array(1599), 16000);
    expect(socket.binaries).toHaveLength(0);

    client.write(new Float32Array(1), 16000);
    expect(socket.binaries).toHaveLength(1);
    // leading 'p' plus 1600 samples at 2 bytes each
    expect(socket.binaries[0]?.byteLength).toBe(1 + 3200);
  });

  it("downsamples 48 kHz input to 16 kHz", async () => {
    const { client, socket } = await started();
    client.write(new Float32Array(4800), 48000);
    expect(socket.binaries).toHaveLength(1);
    expect(socket.binaries[0]?.byteLength).toBe(1 + 3200);
  });

  it("discards audio handed over while disconnected", async () => {
    const client = makeClient();
    const starting = client.start();
    latest().open();
    // The s response has not arrived. Buffering here would deliver past audio as
    // the current utterance once recognition starts.
    client.write(new Float32Array(16000), 16000);
    expect(latest().binaries).toHaveLength(0);

    latest().receive("s");
    await starting;
    client.write(new Float32Array(1600), 16000);
    expect(latest().binaries).toHaveLength(1);
  });
});

describe("finish", () => {
  it("sends e and waits for the response before closing", async () => {
    const { client, socket } = await started();
    const pending = client.finish();
    expect(socket.texts.at(-1)).toBe("e");
    expect(client.connectionState).toBe("closing");

    socket.receive("e");
    await pending;
    expect(client.connectionState).toBe("closed");
  });

  it("gives up after the timeout when no response arrives", async () => {
    vi.useFakeTimers();
    try {
      const { client } = await started({ finishTimeoutMs: 1000 });
      const pending = client.finish();
      vi.advanceTimersByTime(1000);
      await pending;
      expect(client.connectionState).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a final result that lands just before e", async () => {
    const onFinal = vi.fn();
    const { client, socket } = await started({ onFinal });
    const pending = client.finish();
    socket.receive('A {"text":"さようなら"}');
    socket.receive("e");
    await pending;
    expect(onFinal).toHaveBeenCalledWith("さようなら");
  });
});

describe("reconnect", () => {
  it("reconnects when the close was not ours", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = await started();
      socket.close();
      expect(FakeSocket.instances).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the retry limit", async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { socket } = await started({
        onClose,
        reconnect: { maxRetries: 1 },
      });
      socket.close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(2);

      latest().close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(onClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after close", async () => {
    vi.useFakeTimers();
    try {
      const { client } = await started();
      client.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect when reconnect is false", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = await started({ reconnect: false });
      socket.close();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
