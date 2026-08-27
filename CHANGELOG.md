# Changelog

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
