"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildAudioPacket,
  buildStartCommand,
  floatToInt16,
  resample,
} from "../index";

/**
 * The page is the pipeline: microphone, resample, Int16, packet, and the results
 * that would come back.
 *
 * Everything up to the network runs for real, using the package's own functions.
 * The last stage is dark because a live recognition demo would need this site to
 * hold an AmiVoice account, and anyone could then spend it.
 */

const TARGET_RATE = 16_000;
const SEND_INTERVAL_MS = 100;
const SAMPLES_PER_PACKET = (TARGET_RATE * SEND_INTERVAL_MS) / 1000;

function toHex(bytes: Uint8Array, count: number): string {
  return Array.from(bytes.slice(0, count))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

type Stats = {
  inputRate: null | number;
  packets: number;
  peak: number;
  resampled: number;
  taken: number;
};

const EMPTY: Stats = {
  inputRate: null,
  packets: 0,
  peak: 0,
  resampled: 0,
  taken: 0,
};

export default function Home() {
  const [error, setError] = useState<null | string>(null);
  const [hex, setHex] = useState<null | string>(null);
  const [listening, setListening] = useState(false);
  const [stats, setStats] = useState<Stats>(EMPTY);
  const bufferRef = useRef<Int16Array>(new Int16Array(0));
  const contextRef = useRef<AudioContext | null>(null);
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

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silent = context.createGain();
      silent.gain.value = 0;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const value = Math.abs(input[i] ?? 0);
          if (value > peak) peak = value;
        }

        // The package's own functions, in the order the client calls them.
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

        let made = 0;
        while (bufferRef.current.length >= SAMPLES_PER_PACKET) {
          const chunk = bufferRef.current.slice(0, SAMPLES_PER_PACKET);
          bufferRef.current = bufferRef.current.slice(SAMPLES_PER_PACKET);
          setHex(toHex(buildAudioPacket(chunk), 14));
          made += 1;
        }

        setStats((previous) => ({
          inputRate: event.inputBuffer.sampleRate,
          packets: previous.packets + made,
          peak,
          resampled: previous.resampled + resampled.length,
          taken: previous.taken + input.length,
        }));
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

  const startCommand = buildStartCommand({ token: "YOUR_ONE_TIME_TOKEN" });

  return (
    <div className="flex min-h-screen flex-col bg-[#0b0b0f] text-zinc-200">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-zinc-800 px-5 py-3">
        <h1 className="font-display text-base font-bold tracking-tight text-white">
          amivoice-realtime
        </h1>
        <p className="mr-auto text-xs text-zinc-500">
          Speech in, partial and final out
        </p>
        <span className="text-[11px] text-zinc-600">
          Unofficial. AmiVoice is a trademark of Advanced Media, Inc.
        </span>
      </header>

      {/* the handshake that opens the session */}
      <div className="border-b border-zinc-800 bg-[#08080b] px-5 py-3">
        <p className="mb-1.5 font-mono text-[11px] tracking-wide text-zinc-600 uppercase">
          s command · sent once on connect
        </p>
        <code className="block overflow-x-auto font-mono text-xs whitespace-nowrap text-violet-300">
          {startCommand}
        </code>
      </div>

      {/* the pipeline, left to right */}
      <main className="flex flex-1 flex-col justify-center px-5 py-10">
        <div className="flex items-stretch gap-0 overflow-x-auto">
          <Stage
            accent="#a78bfa"
            active={listening}
            detail={stats.inputRate ? `${stats.inputRate} Hz` : "getUserMedia"}
            title="Microphone"
          >
            <div className="flex h-14 items-end gap-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  className="w-2 rounded-full bg-violet-400"
                  key={`peak-${i}`}
                  style={{
                    height: `${Math.max(6, Math.min(100, stats.peak * 180 * (1 - Math.abs(i - 2.5) / 6)))}%`,
                  }}
                />
              ))}
            </div>
          </Stage>

          <Arrow active={listening} />

          <Stage
            accent="#a78bfa"
            active={listening}
            detail={`${TARGET_RATE} Hz`}
            title="resample()"
          >
            <p className="font-mono text-2xl text-zinc-300">
              {stats.resampled.toLocaleString("en-US")}
              <span className="mt-1 block text-[11px] text-zinc-600">
                samples out of {stats.taken.toLocaleString("en-US")}
              </span>
            </p>
          </Stage>

          <Arrow active={listening} />

          <Stage
            accent="#a78bfa"
            active={listening}
            detail="big-endian"
            title="floatToInt16()"
          >
            <p className="font-mono text-sm leading-relaxed text-zinc-400">
              MSB16K
              <span className="mt-1 block text-[11px] text-zinc-600">
                most significant byte first
              </span>
            </p>
          </Stage>

          <Arrow active={listening} />

          <Stage
            accent="#a78bfa"
            active={listening}
            detail={`${stats.packets} sent`}
            title="p packet"
            wide
          >
            <code className="block font-mono text-xs break-all text-violet-200">
              {hex ? `${hex} …` : "70 …"}
            </code>
            <p className="mt-2 font-mono text-[11px] text-zinc-600">
              every {SEND_INTERVAL_MS} ms · {SAMPLES_PER_PACKET} samples
            </p>
          </Stage>

          <Arrow active={false} />

          {/* the one stage that cannot run here */}
          <Stage
            accent="#3f3f46"
            active={false}
            detail="not on this page"
            title="AmiVoice"
          >
            <p className="font-mono text-xs leading-relaxed text-zinc-600">
              partial
              <span className="mt-1 block">partial</span>
              <span className="mt-1 block text-zinc-500">final</span>
            </p>
          </Stage>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            className="rounded-md border border-violet-500/60 px-4 py-2 text-sm text-violet-300 transition-colors hover:border-violet-400 hover:text-violet-200"
            onClick={listening ? stop : start}
            type="button"
          >
            {listening ? "stop" : "run the pipeline on my voice"}
          </button>
          {error ? (
            <span className="text-sm text-red-300">{error}</span>
          ) : (
            <span className="text-xs leading-relaxed text-zinc-600">
              Everything up to the last stage runs for real, using the package's
              own functions. Nothing leaves your browser.
            </span>
          )}
        </div>
      </main>

      <p className="px-5 pb-6 text-xs leading-relaxed text-zinc-600">
        The last stage is dark on purpose. Recognition needs a service ID and
        password, and a token endpoint on a public page would let anyone spend
        the account behind it. In your own app that stage is one{" "}
        <code className="text-zinc-500">createTokenCache</code> call on the
        server.
      </p>

      <footer className="flex flex-wrap items-center gap-4 border-t border-zinc-800 px-5 py-4 text-sm">
        <code className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-300">
          npm i amivoice-realtime
        </code>
        <a
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          href="https://github.com/piro0919/amivoice-realtime"
          rel="noreferrer"
          target="_blank"
        >
          GitHub →
        </a>
        <a
          className="text-zinc-500 transition-colors hover:text-zinc-300"
          href="https://www.npmjs.com/package/amivoice-realtime"
          rel="noreferrer"
          target="_blank"
        >
          npm →
        </a>
        <a
          className="ml-auto text-zinc-600 transition-colors hover:text-zinc-400"
          href="https://kkweb.io/"
          rel="noreferrer"
          target="_blank"
        >
          kkweb.io
        </a>
      </footer>
    </div>
  );
}

function Stage({
  accent,
  active,
  children,
  detail,
  title,
  wide,
}: {
  accent: string;
  active: boolean;
  children: React.ReactNode;
  detail: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`flex ${wide ? "w-64" : "w-48"} shrink-0 flex-col gap-3 rounded-lg border p-4 transition-colors`}
      style={{
        borderColor: active ? `${accent}55` : "#27272a",
        opacity: active ? 1 : 0.6,
      }}
    >
      <div>
        <p className="font-mono text-sm text-white">{title}</p>
        <p className="mt-0.5 font-mono text-[11px]" style={{ color: accent }}>
          {detail}
        </p>
      </div>
      {children}
    </div>
  );
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="flex w-8 shrink-0 items-center justify-center"
    >
      <div
        className="h-px w-full transition-colors"
        style={{ background: active ? "#7c3aed" : "#27272a" }}
      />
    </div>
  );
}
