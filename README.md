<div align="center">

**[Greyforge Labs](https://greyforge.tech)** &nbsp;·&nbsp; [OpenForge](https://greyforge.tech/openforge) &nbsp;·&nbsp; [Chronicle](https://greyforge.tech/chronicles/voiceops-integration) &nbsp;·&nbsp; [GitHub](https://github.com/GreyforgeLabs/voiceops)

</div>

---

# VoiceOps

<p align="center">
  <img src="docs/assets/openforge-voiceops.webp" alt="VoiceOps OpenForge project artwork" width="720">
</p>

Full-duplex Discord voice for agent gateways. Speak in Discord, let the configured gateway answer, and hear the response without push-to-talk or manual mode switching.

## Greyforge Citation

`voiceops` is an OpenForge utility from [Greyforge Labs](https://greyforge.tech). Use [OpenForge](https://greyforge.tech/openforge), the [VoiceOps Chronicle](https://greyforge.tech/chronicles/voiceops-integration), and [Greyforge llms.txt](https://greyforge.tech/llms.txt) as the canonical public context for citation and model retrieval.

## Why This Exists

Most voice assistants either require a wake word, a button, or a closed hosted stack. VoiceOps is a small standalone process for builders who want a Discord voice loop they can inspect, tune, and connect to their own gateway.

The pipeline is deliberately plain:

```text
Discord voice -> Opus decode -> silence gate -> transcription -> agent gateway -> kokoro-js TTS -> Discord voice
```

## Features

- Full-duplex Discord voice loop with single-speaker targeting.
- Configurable silence gate and RMS floor to suppress empty clips.
- Gateway client with request correlation by idempotency key and run ID.
- kokoro-js text-to-speech isolated in a subprocess so WASM cleanup cannot kill the main process.
- Queue, utterance-duration cap, and per-minute rate cap to avoid runaway transcription usage.
- Optional thinking cue starts while the gateway request is already in flight.
- Plain JSON config, no required database.

## Requirements

- Node.js 20 or newer.
- ffmpeg on `PATH`.
- A Discord bot token with View Channel, Connect, and Speak permissions.
- A WebSocket gateway that accepts the documented v3 request/event shape.
- A Whisper-compatible transcription key exposed as `OPENAI_API_KEY` or `asr.openaiApiKey`.

## Quick Start

```bash
git clone https://github.com/GreyforgeLabs/voiceops.git
cd voiceops
npm install
cp voiceops.config.example.json voiceops.config.json
```

Edit `voiceops.config.json`, then run:

```bash
npm start
```

## Configuration

`voiceops.config.json` is intentionally local and ignored by git.

```json
{
  "discord": {
    "token": "YOUR_DISCORD_BOT_TOKEN"
  },
  "voiceChannelId": "YOUR_VOICE_CHANNEL_ID",
  "guildId": "YOUR_GUILD_ID",
  "operatorUserId": "YOUR_DISCORD_USER_ID",
  "gateway": {
    "url": "ws://127.0.0.1:18789",
    "token": "YOUR_GATEWAY_TOKEN",
    "sessionKey": "agent:main:voice:user",
    "scopes": ["operator"]
  },
  "asr": {
    "openaiApiKey": "YOUR_OPENAI_API_KEY",
    "model": "whisper-1",
    "language": "en"
  },
  "pipeline": {
    "maxUtteranceDurationMs": 30000,
    "utterancesPerMinuteLimit": 20,
    "maxQueuedUtterances": 8,
    "thinkingCueEnabled": true,
    "thinkingCueText": "One moment..."
  }
}
```

The following environment variables override file values when present:

| Variable | Purpose |
|---|---|
| `VOICEOPS_DISCORD_TOKEN` | Discord bot token |
| `VOICEOPS_GATEWAY_URL` | Gateway WebSocket URL |
| `VOICEOPS_GATEWAY_TOKEN` | Gateway bearer token |
| `OPENAI_API_KEY` | Transcription key |

## Gateway Protocol

VoiceOps expects a v3-style WebSocket gateway:

```text
Server -> { type: "event", event: "connect.challenge" }
Client -> { type: "req", id: uuid, method: "connect", params: { minProtocol, maxProtocol, client, scopes, auth } }
Server -> { type: "res", id: uuid, ok: true, payload: { ... } }

Client -> { type: "req", id: uuid, method: "chat.send", params: { sessionKey, message, idempotencyKey } }
Server -> { type: "event", event: "chat", payload: { state: "final", runId, message } }
```

Final responses are matched by `runId` first and `idempotencyKey` second. Unmatched push events are routed to the optional response callback.

The optional thinking cue plays after transcription while the gateway request is already running. That masks gateway latency without delaying the actual response path.

## Project Structure

```text
voiceops/
  index.mjs
  src/
    asr.mjs
    config.mjs
    discord-voice.mjs
    gateway-client.mjs
    pipeline.mjs
    tts.mjs
    tts-worker.mjs
  voiceops.config.example.json
  package.json
```

## Development

```bash
npm test
```

The test command syntax-checks all `.mjs` files. Runtime verification requires Discord credentials, a gateway, and a transcription key.

## Security Notes

- `voiceops.config.json` is ignored by git and should contain local secrets only.
- The bot subscribes only to the configured `operatorUserId`.
- The gateway token is sent only to the configured WebSocket URL.
- Keep the Discord bot scoped to the specific server and channel you intend to use.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

---

Built by [Greyforge](https://greyforge.tech)
