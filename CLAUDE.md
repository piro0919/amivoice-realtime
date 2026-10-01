# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**amivoice-realtime** is an unofficial client for realtime speech recognition on the
AmiVoice Cloud Platform WebSocket interface. It does not acquire the microphone: the
caller hands it Float32 samples, so where the audio comes from stays their decision.

- **npm package:** amivoice-realtime
- **Demo site:** <https://amivoice-realtime.kkweb.io>
- **Not an official library from Advanced Media, Inc. AmiVoice is their trademark.**

## Tech Stack

- TypeScript 5, no runtime dependencies
- Next.js 16 (App Router) — demo site only
- Biome (linter/formatter)
- tsup (library build, ESM + CJS)
- Vitest, plus a real `ws` server for the round trip — tests
- Vercel (deployment)

## Project Structure

```text
src/
├── index.ts     # browser entry point: the client and the codec helpers
├── client.ts    # connection, audio sending, reconnect
├── codec.ts     # PCM conversion, resampling, packet building and parsing
├── server.ts    # `amivoice-realtime/server`: token issuing. Server only
└── app/         # Next.js App Router (demo site)
tests/           # unit tests plus a round trip over a real WebSocket
assets/          # Sora subset drawn into the Open Graph card
```

## Protocol notes

Confirmed against the official documentation, not guessed.

- **`s` / `p` / `e` responses carry no body on success and an error message on
  failure.** This is the only place a failed authentication becomes visible; miss it
  and the caller keeps sending audio while waiting for results that never come.
- **`MSB16K` is big-endian at 16 kHz.** Most Significant Byte first; `LSB…` is
  little-endian. The client picks the byte order from `codec` (`pcmByteOrder`) and
  refuses non-PCM formats. Reversed, speech registers as noise.
- **One-time APPKEYs are reusable until they expire**, despite the name.
  `createTokenCache` depends on that.
- **A bodied `s` response stops the client without reconnecting** and rejects
  `start()`. Retrying a refused token just spends more of them.
- **`U` / `A` bodies are always JSON objects.** Anything else goes to `onError`.
- **`finish()` waits for the `e` response** because the final result of the last
  utterance arrives before it.
- **Audio handed over while disconnected is discarded**, never buffered. Buffering
  delivers past audio as the current utterance.

## `start()`

Resolves when the `s` command succeeds and rejects when recognition cannot start
(token, codec, refused `s`, reconnect exhausted, or `close()` first — an
`AbortError`). Tests that drive a fake socket must not `await start()` before
answering `s`.

## Credentials

The service ID and password must never reach the browser. `createTokenCache` and
`issueAmiVoiceToken` live behind the `/server` entry point for that reason. The demo
site therefore stops at the packet layer: a token endpoint on a public page would let
anyone spend the account behind it.

## Commands

```bash
pnpm dev         # demo site
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm build:lib   # tsup -> dist
pnpm build       # next build (demo site)
```

## Releasing

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then push a `vX.Y.Z`
tag. `.github/workflows/publish.yml` publishes to npm with provenance and fails if
the tag and the version disagree.
