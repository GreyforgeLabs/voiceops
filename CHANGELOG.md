# Changelog

All notable changes to VoiceOps are documented here.

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
