import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmiVoiceRealtimeClient, type WebSocketLike } from "./client.js";

const OPEN = 1;
const CLOSED = 3;

/** 試験用の WebSocket。送ったものを覚え、届いたことにできる。 */
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

  /** 接続が開いたことにする。 */
  public open(): void {
    this.onopen?.({});
  }

  /** サーバーからのパケットが届いたことにする。 */
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
  overrides: Partial<ConstructorParameters<typeof AmiVoiceRealtimeClient>[0]> = {},
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

/** 接続して `s` の成功応答まで済ませる。 */
async function started(
  overrides: Partial<ConstructorParameters<typeof AmiVoiceRealtimeClient>[0]> = {},
): Promise<{ client: AmiVoiceRealtimeClient; socket: FakeSocket }> {
  const client = makeClient(overrides);
  await client.start();
  const socket = latest();
  socket.open();
  socket.receive("s");
  return { client, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
});

describe("start", () => {
  it("既定の宛先へ繋ぐ", async () => {
    await started();
    expect(latest().url).toBe("wss://acp-api.amivoice.com/v1/");
  });

  it("接続が開いたら s コマンドを送る", async () => {
    const { socket } = await started({ profileId: "acme" });
    expect(socket.texts[0]).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=TOKEN profileId=acme",
    );
  });

  it("トークンは接続のたびに取り直す", async () => {
    const token = vi.fn().mockResolvedValue("FRESH");
    const client = makeClient({ token });
    await client.start();
    latest().open();
    expect(token).toHaveBeenCalledTimes(1);
    expect(latest().texts[0]).toContain("authorization=FRESH");
  });

  it("s の成功応答が来るまで open にしない", async () => {
    const onOpen = vi.fn();
    const client = makeClient({ onOpen });
    await client.start();
    latest().open();
    expect(onOpen).not.toHaveBeenCalled();
    expect(client.connectionState).toBe("connecting");

    latest().receive("s");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(client.connectionState).toBe("open");
  });
});

describe("認識結果", () => {
  it("U を途中経過として渡す", async () => {
    const onPartial = vi.fn();
    const { socket } = await started({ onPartial });
    socket.receive('U {"text":"おは"}');
    expect(onPartial).toHaveBeenCalledWith("おは");
  });

  it("A を確定結果として渡す", async () => {
    const onFinal = vi.fn();
    const { socket } = await started({ onFinal });
    socket.receive('A {"text":"おはようございます"}');
    expect(onFinal).toHaveBeenCalledWith("おはようございます");
  });

  it("エラーの本体を結果として渡さない", async () => {
    const onFinal = vi.fn();
    const { socket } = await started({ onFinal });
    socket.receive('A {"code":"o","message":"error"}');
    expect(onFinal).not.toHaveBeenCalled();
  });
});

describe("コマンドの失敗応答", () => {
  it("s に本体が付いていたらエラーにする", async () => {
    const onError = vi.fn();
    const onOpen = vi.fn();
    const client = makeClient({ onError, onOpen });
    await client.start();
    latest().open();
    latest().receive("s Authentication failed");

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "AmiVoice s command failed: Authentication failed",
      }),
    );
    // 認識は始まっていない。ここを open にすると、送った音声が捨てられている
    // ことに気づけないまま無音の結果を待つことになる。
    expect(onOpen).not.toHaveBeenCalled();
    expect(client.connectionState).toBe("connecting");
  });

  it("p に本体が付いていたらエラーにする", async () => {
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
  it("100 ミリ秒ぶん溜まってから送る", async () => {
    const { client, socket } = await started();
    // 16 kHz の 100 ミリ秒は 1600 サンプル。手前では 1 つも出さない。
    client.write(new Float32Array(1599), 16000);
    expect(socket.binaries).toHaveLength(0);

    client.write(new Float32Array(1), 16000);
    expect(socket.binaries).toHaveLength(1);
    // 先頭の 'p' + 1600 サンプル × 2 バイト
    expect(socket.binaries[0]?.byteLength).toBe(1 + 3200);
  });

  it("48 kHz の入力を 16 kHz へ落として送る", async () => {
    const { client, socket } = await started();
    client.write(new Float32Array(4800), 48000);
    expect(socket.binaries).toHaveLength(1);
    expect(socket.binaries[0]?.byteLength).toBe(1 + 3200);
  });

  it("繋がっていない間の音声は捨てる", async () => {
    const client = makeClient();
    await client.start();
    latest().open();
    // s の応答がまだ。ここで溜めると、認識が始まった後に過去の音声が
    // 今の発話として届く。
    client.write(new Float32Array(16000), 16000);
    expect(latest().binaries).toHaveLength(0);

    latest().receive("s");
    client.write(new Float32Array(1600), 16000);
    expect(latest().binaries).toHaveLength(1);
  });
});

describe("finish", () => {
  it("e を送り、応答を待ってから切る", async () => {
    const { client, socket } = await started();
    const pending = client.finish();
    expect(socket.texts.at(-1)).toBe("e");
    expect(client.connectionState).toBe("closing");

    socket.receive("e");
    await pending;
    expect(client.connectionState).toBe("closed");
  });

  it("応答が来なければ待ち時間で切り上げる", async () => {
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

  it("e の直前に届いた確定結果を渡す", async () => {
    const onFinal = vi.fn();
    const { client, socket } = await started({ onFinal });
    const pending = client.finish();
    socket.receive('A {"text":"さようなら"}');
    socket.receive("e");
    await pending;
    expect(onFinal).toHaveBeenCalledWith("さようなら");
  });
});

describe("再接続", () => {
  it("こちらから切っていなければ繋ぎ直す", async () => {
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

  it("上限まで来たら諦める", async () => {
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

  it("close の後は繋ぎ直さない", async () => {
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

  it("reconnect: false なら繋ぎ直さない", async () => {
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
