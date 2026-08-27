import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { AmiVoiceRealtimeClient } from "./client.js";

/**
 * 本物の WebSocket 越しに通す。作り物の socket では、パケットの境目や
 * バイナリの扱いのように「経路が本物でないと出ない」壊れ方が見つからない。
 *
 * Node の組み込み `WebSocket` を使うので、既定の実装を選ぶ経路も一緒に通る。
 */
describe("実サーバー越しの往復", () => {
  let server: WebSocketServer;
  let url: string;
  let connections: WsSocket[] = [];
  let clients: AmiVoiceRealtimeClient[] = [];
  /** サーバーが受け取ったものを、文字列とバイナリに分けて溜める。 */
  let receivedText: string[] = [];
  let receivedBinary: Buffer[] = [];

  beforeEach(async () => {
    connections = [];
    clients = [];
    receivedText = [];
    receivedBinary = [];
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    server.on("connection", (socket) => {
      connections.push(socket);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          receivedBinary.push(data as Buffer);
          return;
        }
        const text = data.toString();
        receivedText.push(text);
        if (text.startsWith("s ")) socket.send("s");
        if (text === "e") socket.send("e");
      });
    });
  });

  afterEach(async () => {
    // 失敗して抜けたときも必ず閉じる。開いたままにすると server.close() が
    // 返らず、本当の失敗の代わりに時間切れが報告される。
    for (const client of clients) client.close();
    for (const socket of connections) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 後で必ず閉じるために覚えておく。 */
  function track(client: AmiVoiceRealtimeClient): AmiVoiceRealtimeClient {
    clients.push(client);
    return client;
  }

  async function waitFor(
    predicate: () => boolean,
    label: string,
  ): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("開始・送出・終了を一通り通す", async () => {
    const partials: string[] = [];
    const finals: string[] = [];
    const client = track(new AmiVoiceRealtimeClient({
      onFinal: (text) => finals.push(text),
      onPartial: (text) => partials.push(text),
      profileId: "test-profile",
      token: async () => "TOKEN",
      url,
    }));

    await client.start();
    await waitFor(() => client.connectionState === "open", "open");
    expect(receivedText[0]).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=TOKEN profileId=test-profile",
    );

    // 16 kHz の 100 ミリ秒ぶん。1 パケットになる。
    // 全標本を 0.5 にすると Int16 では 0x3fff になり、バイトの並びが読める。
    const samples = new Float32Array(1600).fill(0.5);
    client.write(samples, 16000);
    await waitFor(() => receivedBinary.length === 1, "audio packet");

    const packet = receivedBinary[0]!;
    expect(packet.length).toBe(1 + 3200);
    expect(packet[0]).toBe(0x70);
    // 上位バイトが先。逆に並べると 0xff, 0x3f になり、雑音として認識される。
    expect(packet[1]).toBe(0x3f);
    expect(packet[2]).toBe(0xff);

    const socket = connections[0]!;
    socket.send('U {"text":"おはよ"}');
    socket.send('A {"text":"おはようございます"}');
    await waitFor(() => finals.length === 1, "final result");
    expect(partials).toEqual(["おはよ"]);
    expect(finals).toEqual(["おはようございます"]);

    await client.finish();
    expect(receivedText.at(-1)).toBe("e");
    expect(client.connectionState).toBe("closed");
  });

  it("認証に失敗したらエラーを渡し、開いたことにしない", async () => {
    // 実際の失敗の形。s に本体が付いて返る。
    server.removeAllListeners("connection");
    server.on("connection", (socket) => {
      socket.on("message", () => socket.send("s Authentication failed"));
    });

    const errors: Error[] = [];
    const client = track(new AmiVoiceRealtimeClient({
      onError: (error) => errors.push(error),
      reconnect: false,
      token: "BAD",
      url,
    }));
    await client.start();
    await waitFor(() => errors.length > 0, "error");

    expect(errors[0]?.message).toBe(
      "AmiVoice s command failed: Authentication failed",
    );
    expect(client.connectionState).not.toBe("open");
    client.close();
  });
});
