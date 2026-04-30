<div align="center">

**[Greyforge Labs](https://greyforge.tech)** &nbsp;·&nbsp; [OpenForge](https://greyforge.tech/openforge) &nbsp;·&nbsp; [Chronicle](https://greyforge.tech/chronicles/voiceops-integration) &nbsp;·&nbsp; [GitHub](https://github.com/GreyforgeLabs/voiceops)

</div>

---

# VoiceOps

<p align="center">
  <img src="docs/assets/openforge-voiceops.webp" alt="VoiceOps OpenForge project artwork" width="720">
</p>

**Full-duplex Discord voice pipeline for OpenClaw.**
Speak into Discord. An AI agent listens, thinks, and speaks back — hands-free, no buttons, no modes.

> The first fully operational voice bot built for the OpenClaw agent platform.
> Built by [Greyforge Labs](https://greyforge.tech).
> Validated by adversarial multi-agent pre-build audit before a single line of implementation was written.

Chronicle: [greyforge.tech/chronicles/voiceops-integration](https://greyforge.tech/chronicles/voiceops-integration)

---

## What is "full duplex"?

A walkie-talkie is half-duplex: one side talks, the other listens, then they switch. You press a button.

A phone call is full-duplex: both sides transmit simultaneously, in real time. No button-pressing, no mode-switching.

VoiceOps is full-duplex for Discord. You join a voice channel. The bot is already there, listening. You speak naturally. When you finish (detected by 800ms of silence), the bot transcribes your words, sends them to an OpenClaw AI agent, synthesizes the response with a local neural TTS engine, and plays it back through the voice channel. The whole loop — from the end of your sentence to the first word of the response — takes 3 to 7 seconds.

---

## What is OpenClaw?

[OpenClaw](https://github.com/GreyforgeLabs) is a local AI agent platform built around a persistent WebSocket gateway. It hosts a council of AI agents (using models from Anthropic, Google, and OpenAI), manages sessions, routing, and multi-agent coordination, and exposes a single unified API over its v3 Gateway protocol.

VoiceOps is a standalone process that plugs into the OpenClaw Gateway over WebSocket. It does not modify OpenClaw internals — it simply speaks the Gateway protocol, sending voice turns as `chat.send` requests and receiving agent responses as `chat` events.

---

## Pipeline

```
 ┌─────────────────────────────────────────────────────────────────┐
 │                        VoiceOps Pipeline                        │
 └─────────────────────────────────────────────────────────────────┘

  You speak in Discord
        │
        ▼
  ┌─────────────┐
  │  Discord RX │  @discordjs/voice receives Opus-encoded audio
  │  (Opus UDP) │  from the operator (target Discord user) only.
  └──────┬──────┘
         │  Opus frames (48kHz stereo)
         ▼
  ┌─────────────┐
  │ Opus Decode │  prism-media decodes to PCM16 16kHz mono
  │  (prism)    │  (Whisper-compatible format)
  └──────┬──────┘
         │  Raw PCM buffer
         ▼
  ┌──────────────────┐
  │  Silence VAD +   │  EndBehaviorType.AfterSilence (800ms)
  │  RMS Energy Gate │  RMS threshold filters near-silence clips.
  │                  │  Min utterance: 500ms. Max: 30s.
  └──────┬───────────┘
         │  PCM buffer (utterance complete)
         ▼
  ┌─────────────┐
  │  Whisper    │  WAV header prepended to PCM.
  │  ASR API    │  Posted to OpenAI whisper-1 (or local whisper.cpp).
  └──────┬──────┘
         │  Transcript text
         ▼
  ┌──────────────────┐
  │  OpenClaw        │  WebSocket v3 Gateway (ws://127.0.0.1:18789)
  │  Gateway Client  │  chat.send → configured voiceSessionKey session
  └──────┬───────────┘
         │  Agent response text (streaming → final event)
         ▼
  ┌─────────────┐
  │  kokoro-js  │  Local neural TTS. 82MB ONNX model.
  │  TTS Engine │  Runs in subprocess (WASM isolation pattern).
  └──────┬──────┘
         │  WAV buffer (24kHz mono 16-bit)
         ▼
  ┌─────────────┐
  │  Discord TX │  @discordjs/voice + ffmpeg encode WAV → Opus.
  │  (Opus UDP) │  Played back into the voice channel.
  └─────────────┘

  You hear the response.
```

---

## Latency Breakdown

| Stage | Time |
|---|---|
| VAD / silence detection | 800ms |
| Whisper ASR (5s clip) | 500ms - 1.5s |
| Agent reasoning | 1 - 3s |
| kokoro-js TTS synthesis (warm) | < 300ms |
| Discord TX buffering | ~200ms |
| **Total end-to-end** | **3 - 7s** |

The "thinking cue" feature (configurable) plays a short audio phrase ("Let me think about that...") immediately after transcription, masking the agent reasoning latency.

TTS cold start is ~1-2s on first call (82MB ONNX model load). Subsequent calls are < 300ms because the subprocess is respawned with model load amortized per call.

VAD cold start is 43ms one-time. Per-frame cost is < 1ms.

---

## TTS Engine Comparison

Five TTS options were evaluated before selecting kokoro-js. The winner had to be free, local, and fast.

| Engine | Latency | Quality | Cost |
|---|---|---|---|
| **kokoro-js (CHOSEN)** | **< 300ms warm** | **Excellent (near-ElevenLabs)** | **$0** |
| piper-tts | < 1s | Good | $0 |
| edge-tts | 1 - 2s | Excellent | $0 (cloud) |
| espeak-ng | < 100ms | Robotic | $0 |
| ElevenLabs Starter | 300 - 800ms | Excellent | ~$0.108/turn |

kokoro-js uses the [Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) model from HuggingFace. It runs entirely locally via ONNX Runtime. No API key, no cloud round-trip.

---

## Cost Analysis

| Configuration | Cost per turn |
|---|---|
| kokoro-js TTS + Whisper API | ~$0.0005 (ASR only) |
| kokoro-js TTS + local whisper.cpp | $0.00 |
| ElevenLabs TTS + Whisper API | ~$0.108 |

At 20 turns per session, the Whisper-only configuration costs about $0.01 per session. The fully local (whisper.cpp) configuration costs nothing.

---

## Requirements

- Node.js 20 or higher
- A running OpenClaw Gateway instance (v3 protocol, default port 18789)
- A Discord bot token with the following permissions in the target voice channel:
  - View Channel
  - Connect
  - Speak
- An OpenAI API key for Whisper ASR (or local whisper.cpp — see below)
- ffmpeg installed and on PATH (required by @discordjs/voice for audio encoding)

### Tested on

- OS: Ubuntu 24.04 LTS
- CPU: modern multi-core x86_64
- Node: v24.12.0
- Discord.js: v14

---

## Installation

```bash
git clone https://github.com/GreyforgeLabs/voiceops.git
cd voiceops
npm install
```

The kokoro-js package will download the 82MB ONNX model on first TTS call. This is automatic.

---

## Configuration

### 1. VoiceOps config

Copy the example config and fill in your values:

```bash
cp voiceops.config.example.json voiceops.config.json
```

Edit `voiceops.config.json`:

| Key | Description |
|---|---|
| `voiceChannelId` | Right-click your Discord voice channel → Copy Channel ID |
| `guildId` | Right-click your Discord server → Copy Server ID |
| `operatorUserId` | Your Discord user ID (the operator who will speak to the bot) |
| `tts.voice` | kokoro-js voice name (default: `af_bella`) |
| `tts.speed` | Speech speed multiplier (default: `1.0`) |
| `vad.silenceDurationMs` | Milliseconds of silence that ends an utterance (default: `800`) |
| `vad.minUtteranceDurationMs` | Clips shorter than this are discarded (default: `500`) |
| `vad.rmsThreshold` | RMS energy floor — clips below this are discarded (default: `0.008`) |
| `asr.model` | Whisper model name (default: `whisper-1`) |
| `asr.language` | Language hint for Whisper (default: `en`) |
| `pipeline.utterancesPerMinuteLimit` | Rate cap to control API costs (default: `20`) |
| `pipeline.thinkingCueEnabled` | Play a short audio cue while the agent is thinking (default: `true`) |
| `pipeline.thinkingCueText` | Text to synthesize as the thinking cue |

To enable Developer Mode in Discord (required to copy IDs): User Settings → App Settings → Advanced → Developer Mode.

### 2. OpenClaw config (`openclaw.json`)

VoiceOps reads from `~/.openclaw/openclaw.json`. The following keys must be present:

| Key | Description |
|---|---|
| `channels.discord.token` | Discord bot token |
| `gateway.auth.token` | OpenClaw Gateway authentication token |
| `gateway.port` | Gateway WebSocket port (default: `18789`) |
| `env.OPENAI_API_KEY` | OpenAI API key for Whisper ASR |

---

## Running

```bash
npm start
```

Or with file watching during development:

```bash
npm run dev
```

On startup, VoiceOps will:

1. Log in to Discord as the bot
2. Verify the bot is a member of the target guild
3. Connect to the OpenClaw Gateway via WebSocket (v3 protocol)
4. Join the configured voice channel
5. Begin listening for the Operator's audio

---

## How It Works

### Listening

The bot subscribes to the Operator's Discord audio stream. Discord sends compressed Opus audio. VoiceOps decodes it to raw 16kHz PCM (the format Whisper expects).

When the Operator stops speaking for 800ms, the audio stream ends. VoiceOps immediately re-subscribes so it is always listening. The collected PCM buffer is then checked against a minimum duration (500ms) and an RMS energy threshold (0.008) to filter out silence and noise. If those checks pass, the buffer goes to Whisper.

### Transcription

The PCM buffer is wrapped in a WAV header and posted to OpenAI's `whisper-1` endpoint. The transcript comes back as plain text.

### Agent turn

The transcript is sent to the OpenClaw Gateway as a `chat.send` request. The session key `agent:main:voice:user` routes it to the main agent. The gateway responds asynchronously: a `chat` event with `state: "final"` carries the complete agent response text.

### Synthesis

The response text is passed to a kokoro-js TTS subprocess. The subprocess loads the ONNX model, synthesizes Float32 audio, converts it to 16-bit PCM, and writes a WAV file to stdout. The main process collects the WAV bytes.

### Playback

The WAV buffer is fed to the Discord AudioPlayer. Discord.js + ffmpeg encode it to Opus and transmit it through the voice channel UDP connection.

### Queue model

If a new utterance arrives while the bot is still processing or playing a previous response, it is queued rather than dropped (subject to the per-minute rate limit). The queue drains in order as each response completes.

---

## TTS Subprocess Isolation

The kokoro-js ONNX phonemizer (Emscripten-compiled WASM) calls `process.exit(7)` during its cleanup cycle. If TTS ran in-process, this would kill VoiceOps.

The solution is the subprocess pattern: `tts.mjs` spawns `tts-worker.mjs` as a child process for every synthesis call. The worker loads the model, synthesizes, writes WAV to stdout, and exits. Exit code 7 is expected and harmless. The main process collects stdout and continues.

---

## VAD Architecture Note

[`@ricky0123/vad-node`](https://github.com/ricky0123/vad) (Silero VAD) was benchmarked: 43ms cold start, 0.42ms per frame. It was not adopted for this release because it depends on `onnxruntime-node@1.24.2`, which conflicts with kokoro-js's dependency on `onnxruntime-node@1.21.0`. Running both simultaneously causes a hard crash.

The adopted VAD is `EndBehaviorType.AfterSilence` (provided by @discordjs/voice, built on Discord's own silence packets) combined with an RMS energy gate in `asr.mjs`. This approach has zero external dependencies and is sufficient for single-speaker desktop use.

Silero VAD can be re-evaluated if/when the ONNX version conflict is resolved upstream.

---

## Gateway Protocol

VoiceOps uses OpenClaw Gateway protocol v3.

```
Connect handshake:
  Server → { type: "event", event: "connect.challenge" }
  Client → { type: "req", id: uuid, method: "connect", params: {
               minProtocol: 3, maxProtocol: 3,
               client: { id, version, platform, mode },
               scopes: ["operator.admin"],
               auth: { token }
             }}
  Server → { type: "res", id: uuid, ok: true, payload: { ... } }

Send a voice turn:
  Client → { type: "req", id: uuid, method: "chat.send", params: {
               sessionKey: "agent:main:voice:user",
               message: "transcript text",
               idempotencyKey: uuid
             }}
  Server → { type: "event", event: "chat", payload: {
               state: "final", runId: idempotencyKey,
               message: { content: [{ type: "text", text: "response" }] }
             }}
```

The `idempotencyKey` sent with `chat.send` is echoed as `runId` in the final chat event, allowing VoiceOps to match responses to the correct pending promise.

---

## Kokoro-js Voice Options

The voice is set via `tts.voice` in `voiceops.config.json`. Available voices in the Kokoro-82M model include:

| Voice | Style |
|---|---|
| `af_bella` | American female, warm (default) |
| `af_sarah` | American female, neutral |
| `am_adam` | American male, neutral |
| `am_michael` | American male, deep |
| `bf_emma` | British female |
| `bm_george` | British male |

See the [kokoro-js documentation](https://github.com/hexgrad/kokoro) for the full voice list.

---

## Project Structure

```
voiceops/
  index.mjs                    Entry point — Discord client, pipeline init, graceful shutdown
  src/
    config.mjs                 Config loader — merges openclaw.json + voiceops.config.json
    pipeline.mjs               Pipeline orchestrator — wires ASR → Gateway → TTS
    discord-voice.mjs          Discord voice channel management (RX + TX + reconnect)
    gateway-client.mjs         OpenClaw Gateway WebSocket client (v3 protocol)
    asr.mjs                    Whisper ASR — PCM → WAV → transcript
    tts.mjs                    TTS coordinator — spawns tts-worker subprocess
    tts-worker.mjs             kokoro-js synthesis worker (subprocess isolation)
  voiceops.config.example.json Configuration template
  package.json
  LICENSE
```

---

## Graceful Shutdown

Send `SIGINT` (Ctrl+C) or `SIGTERM`:

```bash
kill -TERM <pid>
```

VoiceOps will leave the voice channel, close the Gateway WebSocket, and destroy the Discord client before exiting.

---

## Bot Permissions

When inviting the bot to your server, it needs these permissions:

- `bot` scope
- `CONNECT` (permission integer: 1048576)
- `SPEAK` (permission integer: 2097152)

Combined permission integer: `3145728`

The startup log prints a ready-made invite URL:

```
[VoiceOps] Re-invite URL: https://discord.com/oauth2/authorize?client_id=YOUR_BOT_ID&scope=bot&permissions=3145728
```

---

## License

MIT. See [LICENSE](LICENSE).

---

## Background

VoiceOps was designed as a standalone satellite process for the OpenClaw platform. The design goal was a clean, dependency-minimal voice pipeline with no modifications to OpenClaw internals — communication happens entirely through the public Gateway WebSocket API.

Before implementation began, the architecture was validated by an adversarial multi-agent pre-build audit (a dedicated team of AI agents stress-testing the design for failure modes, dependency conflicts, and ONNX version collisions). The VAD architecture note above is one direct output of that audit.

Read the full chronicle: [greyforge.tech/chronicles/voiceops-integration](https://greyforge.tech/chronicles/voiceops-integration)

---

<div align="center">

Built by **[Greyforge Labs](https://greyforge.tech)** &nbsp;·&nbsp; [OpenForge](https://greyforge.tech/openforge) &nbsp;·&nbsp; [GitHub](https://github.com/GreyforgeLabs) &nbsp;·&nbsp; MIT License

</div>
