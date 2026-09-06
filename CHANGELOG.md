# Changelog

All notable changes to VoiceOps are documented here.

## Unreleased

### Security

- Raised `discord.js` to 14.27.0 and `ws` to 8.21.3, and moved the `undici`, `tar`, `protobufjs`, and `sharp` overrides to patched releases so `npm audit` reports zero findings.
- Added `npm run audit`, an allowlist-gated audit script (`scripts/audit.mjs`, `security/audit-allowlist.json`) that fails CI on any unlisted or expired advisory.
- Recorded reviewed install scripts in `allowScripts`.

### Added

- GitHub Actions CI running syntax checks, the test suite, and the audit gate on Node 24.

### Security (2026-05-11 hardening)

- Added schema/range validation for Discord IDs, gateway URL policy, VAD, ASR, pipeline, and TTS settings.
- Rejected remote plaintext gateway URLs by default unless explicitly allowed for a trusted private network.
- Added active PCM stream caps, ASR timeout, gateway message size limits, agent response length limits, and TTS input/output caps.
- Sanitized the TTS worker environment so Discord, gateway, and OpenAI credentials are not inherited by the subprocess.
- Redacted transcript and agent response bodies from logs by default.
- Added config security tests using an isolated `VOICEOPS_CONFIG_PATH`.

## [0.1.0] - 2026-05-02

### Added

- Full-duplex Discord voice pipeline with silence-gated utterance capture.
- WebSocket gateway client with response correlation by run ID and idempotency key.
- kokoro-js TTS worker isolation.
- OpenForge release scaffolding and local setup script.

### Changed

- Reworked configuration around a public, generic gateway adapter.
- Moved runtime secrets into ignored local config or environment variables.
- Relicensed the project as AGPL-3.0-only.

### Fixed

- Prevented duplicate gateway connect resolution and duplicate ping startup.
- Matched final gateway responses through both `runId` and `idempotencyKey`.
- Rejected invalid TTS subprocess output before playback.
