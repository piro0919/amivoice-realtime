import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { AmiVoiceRealtimeClient } from "./client";

/**
 * Run everything over a real WebSocket. A fake socket cannot surface the failures
 * that only appear on a real transport, such as packet framing or binary handling.
 *
 * This uses Node's built-in `WebSocket`, so it also exercises the default
 * implementation lookup.
 */
describe("round trip over a real server", () => {
  let server: WebSocketServer;
  let url: string;
  let connections: WsSocket[] = [];
  let clients: AmiVoiceRealtimeClient[] = [];
  /** Collects what the server received, split into text and binary. */
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
    // Always close, including on a failing exit. Leaving a socket open keeps
    // server.close() from returning, and a timeout gets reported instead of the
    // real failure.
    for (const client of clients) client.close();
    for (const socket of connections) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Remember it so afterEach can always close it. */
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

  it("runs start, send and finish end to end", async () => {
    const partials: string[] = [];
    const finals: string[] = [];
    const client = track(
      new AmiVoiceRealtimeClient({
        onFinal: (text) => finals.push(text),
        onPartial: (text) => partials.push(text),
        profileId: "test-profile",
        token: async () => "TOKEN",
        url,
      }),
    );

    await client.start();
    await waitFor(() => client.connectionState === "open", "open");
    expect(receivedText[0]).toBe(
      "s MSB16K -a-general resultUpdatedInterval=1000 authorization=TOKEN profileId=test-profile",
    );

    // 100 ms at 16 kHz, which makes exactly one packet.
    // Filling with 0.5 gives 0x3fff in Int16, so the byte order is readable.
    const samples = new Float32Array(1600).fill(0.5);
    client.write(samples, 16000);
    await waitFor(() => receivedBinary.length === 1, "audio packet");

    const packet = receivedBinary[0];
    if (!packet) throw new Error("no audio packet was received");
    expect(packet.length).toBe(1 + 3200);
    expect(packet[0]).toBe(0x70);
    // High byte first. Reversed it would be 0xff, 0x3f and register as noise.
    expect(packet[1]).toBe(0x3f);
    expect(packet[2]).toBe(0xff);

    const socket = connections[0];
    if (!socket) throw new Error("no connection was accepted");
    socket.send('U {"text":"おはよ"}');
    socket.send('A {"text":"おはようございます"}');
    await waitFor(() => finals.length === 1, "final result");
    expect(partials).toEqual(["おはよ"]);
    expect(finals).toEqual(["おはようございます"]);

    await client.finish();
    expect(receivedText.at(-1)).toBe("e");
    expect(client.connectionState).toBe("closed");
  });

  it("reports an auth failure and never reports open", async () => {
    // The real failure shape: s comes back carrying a body.
    server.removeAllListeners("connection");
    server.on("connection", (socket) => {
      socket.on("message", () => socket.send("s Authentication failed"));
    });

    const errors: Error[] = [];
    const client = track(
      new AmiVoiceRealtimeClient({
        onError: (error) => errors.push(error),
        reconnect: false,
        token: "BAD",
        url,
      }),
    );
    await client.start();
    await waitFor(() => errors.length > 0, "error");

    expect(errors[0]?.message).toBe(
      "AmiVoice s command failed: Authentication failed",
    );
    expect(client.connectionState).not.toBe("open");
    client.close();
  });
});
