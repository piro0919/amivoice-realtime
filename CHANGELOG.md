# Changelog

## Unreleased

### Fixed

- **BREAKING:** audio goes out in the byte order the `codec` names. `LSB8K` …
  `LSB48K` are now sent little-endian; before, every codec got big-endian bytes,
  so `LSB…` audio arrived as noise. A codec that is not headerless 16-bit PCM
  (`MULAW`, `ALAW`, header formats such as `16K`) makes `start()` reject instead
  of sending audio the server cannot read.
- **BREAKING:** a rejected `s` command — failed authentication above all — closes
  the client and is not retried. Before, the server's hang-up after the failure
  triggered up to five reconnects, each spending a token on the same refusal.
- **BREAKING:** a `U` or `A` body that is not a JSON object is reported to
  `onError` and never delivered as recognized speech. `parseResultBody` returns
  `undefined` for it instead of the raw text.
- **BREAKING:** `start()` (and `createAmiVoiceRealtimeClient`) resolves when
  recognition has started — the moment `onOpen` fires — and rejects when it cannot:
  the token could not be obtained, the codec is unsupported, `s` was refused, the
  connection closed and reconnecting gave up, or `close()` / `finish()` came first
  (an `AbortError`). Before, it resolved as soon as the socket was created and
  never rejected. Calling `start()` while connecting returns the same attempt.
- The token docs said tokens are single-use, which contradicted `createTokenCache`
  reusing them. AmiVoice's one-time APPKEY is valid for any number of connections
  until it expires; the docs now say so.

### Added

- `pcmByteOrder(codec)`, `int16ToLittleEndianBytes`, `isResultBody`, and a
  `byteOrder` argument on `buildAudioPacket` (default `"big"`).
- `typesVersions` lets `moduleResolution: node`
  find the types of `amivoice-realtime/server`. CI checks the packed package with
  `publint --strict` and `attw` (`pnpm check:package`), runs the tests on Node 22
  and 24, and checks both entry points load on Node 18 and 20.

## 0.1.3

### Changed

- Repository layout now matches the other packages: tests live in `tests/`, biome
  runs on commit through lefthook, and `engines` is gone (it pinned nothing useful
  and made the host warn about automatic Node upgrades).

## 0.1.2

### Changed

- Ships both ESM and CJS builds with source maps, so `require()` works alongside
  `import`.

## 0.1.1

### Changed

- Everything is written in English: README, source comments and type documentation.
  The first release carried Japanese prose, which is unhelpful in a public package.

## 0.1.0

Initial release.

### Added

- `AmiVoiceRealtimeClient` — connects to the AmiVoice WebSocket interface, sends
  audio and reports interim and final results. Resampling and packet framing happen
  inside; the caller supplies Float32 samples from wherever it likes.
- `issueAmiVoiceToken` / `createTokenCache` under `amivoice-realtime/server` — issue
  single-use tokens without putting the credentials in the browser.
- Codec helpers usable on their own: `buildStartCommand`, `buildAudioPacket`,
  `floatToInt16`, `resample`, `splitPacket`, `parseResultBody`, `formatProfileWords`.
