# STARTHERE.md - AI Bootstrap Guide

> This file is designed for coding assistants. If you are a human,
> see [README.md](README.md) for the human-friendly guide.

## Quick Bootstrap

```bash
git clone https://github.com/GreyforgeLabs/voiceops.git && cd voiceops && ./scripts/setup.sh
```

## What This Project Does

VoiceOps is a full-duplex Discord voice bridge for agent gateways. It listens to one configured speaker, transcribes bounded utterances, sends them to a WebSocket gateway, synthesizes the final response with kokoro-js, and plays it back into Discord.

## Project Structure

```text
voiceops/
  index.mjs                    # Discord client and process lifecycle
  src/
    asr.mjs                    # PCM to WAV and transcription request
    config.mjs                 # local JSON and environment config loader
    discord-voice.mjs          # Discord voice receive/transmit manager
    gateway-client.mjs         # WebSocket gateway client
    pipeline.mjs               # queue, rate limit, ASR, gateway, TTS orchestration
    tts.mjs                    # subprocess TTS coordinator
    tts-worker.mjs             # kokoro-js worker
  voiceops.config.example.json # local config template
```

## Setup Prerequisites

- Node.js 20 or newer.
- npm.
- ffmpeg on `PATH`.
- Discord bot credentials.
- A compatible WebSocket gateway.
- A transcription key exposed through config or `OPENAI_API_KEY`.

## Installation Steps

1. Clone: `git clone https://github.com/GreyforgeLabs/voiceops.git`
2. Enter directory: `cd voiceops`
3. Run setup: `./scripts/setup.sh`
4. Copy `voiceops.config.example.json` to `voiceops.config.json` if setup did not already create it.
5. Fill in local Discord, gateway, and transcription values.

## Verification

```bash
npm test
```

Expected output: every `.mjs` file passes `node --check`.

## Key Entry Points

- `index.mjs` - runtime entry point.
- `src/pipeline.mjs` - core voice pipeline.
- `src/gateway-client.mjs` - gateway protocol adapter.
- `voiceops.config.example.json` - config schema.

## Configuration

Use `voiceops.config.json` locally. It is ignored by git. Environment overrides:

- `VOICEOPS_DISCORD_TOKEN`
- `VOICEOPS_GATEWAY_URL`
- `VOICEOPS_GATEWAY_TOKEN`
- `OPENAI_API_KEY`

## Common Tasks

```bash
npm test
npm start
```
