# amivoice-realtime

A client for realtime speech recognition on the
[AmiVoice Cloud Platform](https://acp.amivoice.com/) WebSocket interface.

**This is not an official library from Advanced Media, Inc.** AmiVoice is their trademark.

- No runtime dependencies
- Runs in the browser and in Node
- Does not acquire the microphone. You hand it Float32 samples, so where the audio
  comes from stays your decision
- Keeps credentials out of the browser: token issuing lives behind a separate
  server-only entry point

## Install

```bash
npm install amivoice-realtime
```

## Usage

### Server side — issue a token

Connecting requires a single-use authentication token. Issuing one needs the service
ID and password, which must never reach the browser, so the server returns only the
token.

```ts
// app/api/amivoice/token/route.ts (Next.js example)
import { createTokenCache } from "amivoice-realtime/server";

const tokens = createTokenCache({
  serviceId: process.env.AMIVOICE_SERVICE_ID!,
  servicePassword: process.env.AMIVOICE_SERVICE_PASSWORD!,
  expiresInMs: 60_000,
});

export async function GET() {
  // In real code, authenticate the caller here first.
  const { value } = await tokens.get();
  return Response.json({ token: value });
}
```

`createTokenCache` reuses an issued token until shortly before it expires and
collapses concurrent requests into one. Call `issueAmiVoiceToken` directly if you
would rather not reuse.

### Browser side — send audio

```ts
import { AmiVoiceRealtimeClient } from "amivoice-realtime";

const client = new AmiVoiceRealtimeClient({
  // A function is called on every connect, so reconnects get a fresh token
  token: async () => {
    const res = await fetch("/api/amivoice/token");
    return (await res.json()).token;
  },
  onPartial: (text) => setInterim(text),
  onFinal: (text) => appendLine(text),
  onError: (error) => console.error(error),
});

await client.start();

// Hand over the Float32 samples arriving from the microphone.
// Resampling and packing into packets happen inside.
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const context = new AudioContext();
const source = context.createMediaStreamSource(stream);
const processor = context.createScriptProcessor(4096, 1, 1);
processor.onaudioprocess = (event) => {
  client.write(event.inputBuffer.getChannelData(0), context.sampleRate);
};
source.connect(processor);
processor.connect(context.destination);

// When finishing. Waits for the final result of the last utterance before closing.
await client.finish();
```

### In Node

Pass an implementation where there is no global `WebSocket`.

```ts
import WebSocket from "ws";
import { AmiVoiceRealtimeClient } from "amivoice-realtime";

const client = new AmiVoiceRealtimeClient({
  token: "...",
  webSocket: (url) => new WebSocket(url) as never,
});
```

## Registered words

Proper nouns and domain vocabulary can be attached to the `s` command so the engine
recognizes them.

```ts
import { formatProfileWords } from "amivoice-realtime";

const profileWords = formatProfileWords([
  { written: "個浴槽", spoken: "こよくそう", wordClass: "固有名詞" },
  { written: "臥床", spoken: "がしょう" },
]);

new AmiVoiceRealtimeClient({ token, profileWords, profileId: "your-profile" });
```

## Options

| Option | Default | Meaning |
| ---- | ---- | ---- |
| `token` | (required) | The authentication token, or a function returning one |
| `grammar` | `-a-general` | Recognition engine |
| `codec` | `MSB16K` | Audio format: big-endian, 16 kHz |
| `sampleRate` | `16000` | Sample rate of the audio sent. Match it to `codec` |
| `sendIntervalMs` | `100` | How much audio each packet carries |
| `resultUpdatedIntervalMs` | `1000` | How often interim results are sent back |
| `profileId` / `profileWords` | — | Personal dictionary and registered words |
| `reconnect` | up to 5 tries | Reconnect settings. `false` disables it |
| `finishTimeoutMs` | `3000` | How long `finish()` waits for the `e` response |
| `url` | `wss://acp-api.amivoice.com/v1/` | Endpoint |
| `webSocket` | global | The `WebSocket` implementation |
| `startParams` | — | Extra parameters appended to the `s` command |

## What this gets right

Each of these came from running the protocol in production.

- **A bodied `s`, `p` or `e` response is treated as an error.** AmiVoice answers
  these with no body on success and an error message on failure. This is the only
  place a failed authentication becomes visible; miss it and you keep sending audio
  while waiting for results that never come
- **No audio is sent until `s` succeeds.** Anything sent earlier is discarded
- **Audio handed over while disconnected is discarded.** Buffering it would deliver
  past audio as the current utterance
- **`finish()` waits for the `e` response before closing.** Closing immediately
  drops the end of what was said
- **Audio goes out big-endian.** `MSB16K` means Most Significant Byte first. Getting
  it backwards turns speech into noise

## Using the lower layer

Packet building and parsing are usable on their own.

```ts
import {
  buildStartCommand,
  buildAudioPacket,
  floatToInt16,
  parseResultBody,
  resample,
  splitPacket,
} from "amivoice-realtime";
```

## License

MIT
