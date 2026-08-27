"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAudioPacket,
  buildStartCommand,
  floatToInt16,
  formatProfileWords,
  resample,
} from "../index";

/**
 * The demo runs the packet layer only — no credentials, no network.
 *
 * A live recognition demo would need an AmiVoice service ID and password. Putting
 * a token endpoint on a public page would let anyone spend the account behind it,
 * so what runs here is everything up to the moment audio would leave the browser.
 */

const TARGET_RATE = 16_000;
const SEND_INTERVAL_MS = 100;
const SAMPLES_PER_PACKET = (TARGET_RATE * SEND_INTERVAL_MS) / 1000;

function toHex(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.slice(0, count))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

export default function Home() {
  const [error, setError] = useState<null | string>(null);
  const [grammar, setGrammar] = useState("-a-general");
  const [inputRate, setInputRate] = useState<null | number>(null);
  const [listening, setListening] = useState(false);
  const [packetCount, setPacketCount] = useState(0);
  const [packetHex, setPacketHex] = useState<null | string>(null);
  const [peak, setPeak] = useState(0);
  const [profileId, setProfileId] = useState("your-profile");
  const [words, setWords] = useState(
    "個浴槽 こよくそう 固有名詞|臥床 がしょう",
  );
  const contextRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<Int16Array>(new Int16Array(0));
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    bufferRef.current = new Int16Array(0);
    setListening(false);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      if (context.state === "suspended") await context.resume();
      setInputRate(context.sampleRate);

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let loudest = 0;
        for (let i = 0; i < input.length; i++) {
          const value = Math.abs(input[i] ?? 0);
          if (value > loudest) loudest = value;
        }
        setPeak(loudest);

        // Exactly what the client does before a packet leaves the browser.
        const resampled = resample(
          input,
          event.inputBuffer.sampleRate,
          TARGET_RATE,
        );
        const int16 = floatToInt16(resampled);
        const merged = new Int16Array(bufferRef.current.length + int16.length);
        merged.set(bufferRef.current, 0);
        merged.set(int16, bufferRef.current.length);
        bufferRef.current = merged;

        while (bufferRef.current.length >= SAMPLES_PER_PACKET) {
          const chunk = bufferRef.current.slice(0, SAMPLES_PER_PACKET);
          bufferRef.current = bufferRef.current.slice(SAMPLES_PER_PACKET);
          const packet = buildAudioPacket(chunk);
          setPacketHex(toHex(packet, 16));
          setPacketCount((previous) => previous + 1);
        }
      };

      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      setListening(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      stop();
    }
  }, [stop]);

  const startCommand = buildStartCommand({
    grammar,
    profileId: profileId || undefined,
    profileWords: words
      ? formatProfileWords(
          words
            .split("|")
            .map((entry) => entry.trim().split(/\s+/))
            .filter((parts) => parts.length >= 2)
            .map(([written, spoken, wordClass]) => ({
              spoken: spoken ?? "",
              wordClass,
              written: written ?? "",
            })),
        )
      : undefined,
    token: "YOUR_ONE_TIME_TOKEN",
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-10 text-center">
          <h1 className="mb-2 font-display text-4xl font-bold tracking-tight text-white">
            amivoice-realtime
          </h1>
          <p className="text-zinc-400">
            Realtime speech recognition over the AmiVoice WebSocket interface
          </p>
          <p className="mx-auto mt-3 max-w-lg text-xs leading-relaxed text-zinc-500">
            Not an official library from Advanced Media, Inc. AmiVoice is their
            trademark.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3 text-sm">
            <a
              className="rounded-full bg-zinc-700/50 px-4 py-2 text-zinc-300 transition-colors hover:bg-zinc-700"
              href="https://www.npmjs.com/package/amivoice-realtime"
              rel="noreferrer"
              target="_blank"
            >
              npm
            </a>
            <a
              className="rounded-full bg-zinc-700/50 px-4 py-2 text-zinc-300 transition-colors hover:bg-zinc-700"
              href="https://github.com/piro0919/amivoice-realtime"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>
        </header>

        <section className="mb-10 rounded-2xl border border-zinc-700/60 bg-zinc-900/60 p-6">
          <h2 className="font-display text-lg font-bold text-white">
            The start command
          </h2>
          <p className="mt-1 mb-5 text-sm text-zinc-400">
            Built by the package from the options you set. Edit the fields and
            watch it change.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">grammar</span>
              <input
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-zinc-600"
                onChange={(event) => setGrammar(event.target.value)}
                value={grammar}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">profileId</span>
              <input
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-zinc-600"
                onChange={(event) => setProfileId(event.target.value)}
                value={profileId}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1.5 block text-zinc-400">
                words (written spoken class, | separated)
              </span>
              <input
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-zinc-600"
                onChange={(event) => setWords(event.target.value)}
                value={words}
              />
            </label>
          </div>

          <pre className="mt-5 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 font-mono text-xs leading-relaxed text-violet-200">
            <code>{startCommand}</code>
          </pre>
        </section>

        <section className="mb-10 rounded-2xl border border-zinc-700/60 bg-zinc-900/60 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-bold text-white">
                Packets from your microphone
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                {inputRate
                  ? `${inputRate} Hz in, ${TARGET_RATE} Hz out · ${packetCount} packets`
                  : "Resampled, converted to big-endian Int16 and framed."}
              </p>
            </div>
            <button
              className="rounded-full bg-violet-500 px-5 py-2.5 font-medium text-violet-950 transition-colors hover:bg-violet-400"
              onClick={listening ? stop : start}
              type="button"
            >
              {listening ? "Stop" : "Use my microphone"}
            </button>
          </div>

          {error ? (
            <p className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          ) : null}

          <div className="mt-5 h-3 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-violet-400 transition-[width] duration-75"
              style={{ width: `${Math.min(100, peak * 180)}%` }}
            />
          </div>

          <pre className="mt-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 font-mono text-xs text-zinc-300">
            <code>
              {packetHex
                ? `p ${packetHex} …`
                : "70 .. .. .. .. .. .. ..  (waiting for audio)"}
            </code>
          </pre>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            The leading <code className="font-mono">70</code> is the ASCII{" "}
            <code className="font-mono">p</code> of the send command. Everything
            after it is 16 kHz audio, most significant byte first. Nothing
            leaves your browser: a live recognition demo would need this site to
            hold an AmiVoice account, and anyone could then spend it.
          </p>
        </section>

        <section>
          <h2 className="mb-4 font-display text-xl font-bold text-white">
            Install
          </h2>
          <pre className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 font-mono text-sm text-zinc-300">
            <code>npm install amivoice-realtime</code>
          </pre>

          <h2 className="mt-10 mb-4 font-display text-xl font-bold text-white">
            Usage
          </h2>
          <pre className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5 font-mono text-sm text-zinc-300">
            <code>{`// server: issue a single-use token, never ship the credentials
import { createTokenCache } from "amivoice-realtime/server";

const tokens = createTokenCache({
  serviceId: process.env.AMIVOICE_SERVICE_ID,
  servicePassword: process.env.AMIVOICE_SERVICE_PASSWORD,
});

// browser: send audio, receive results
import { AmiVoiceRealtimeClient } from "amivoice-realtime";

const client = new AmiVoiceRealtimeClient({
  token: async () => (await fetch("/api/amivoice/token").then((r) => r.json())).token,
  onPartial: setInterim,
  onFinal: appendLine,
});

await client.start();
client.write(samples, sampleRate);
await client.finish();`}</code>
          </pre>
        </section>

        <footer className="mt-16 text-center text-sm text-zinc-600">
          <a
            className="transition-colors hover:text-zinc-400"
            href="https://kkweb.io/"
            rel="noreferrer"
            target="_blank"
          >
            kkweb.io
          </a>
        </footer>
      </div>
    </div>
  );
}
