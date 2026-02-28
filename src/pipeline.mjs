/**
 * pipeline.mjs — VoiceOps main pipeline orchestrator.
 *
 * Wires together: Discord RX → ASR → Gateway → TTS → Discord TX
 *
 *   1. DiscordVoiceManager calls onUtterance(pcmBuffer) when Operator finishes speaking
 *   2. pipeline transcribes PCM → text (Whisper API)
 *   3. pipeline sends transcript to OpenClaw Gateway as a voice-sourced chat turn
 *   4. Gateway responds; pipeline synthesizes the response text via kokoro-js TTS
 *   5. WAV audio played back through Discord voice channel
 *
 * Rate limiting:  MAX_UTTERANCES_PER_MINUTE cap to prevent runaway API costs.
 * Interrupt model (V1): queue — if a response is currently playing, queue incoming
 *                        utterances rather than interrupting. Reconsider for V2.
 *
 * Built by Greyforge Labs — https://greyforge.tech
 * https://github.com/GreyforgeLabs/voiceops
 */

import { GatewayClient }        from './gateway-client.mjs';
import { DiscordVoiceManager }  from './discord-voice.mjs';
import { transcribe }           from './asr.mjs';
import { synthesize }           from './tts.mjs';
import { config }               from './config.mjs';

const MAX_UTTERANCES_PER_MINUTE = config.pipeline?.utterancesPerMinuteLimit ?? 20;
const THINKING_CUE_ENABLED      = config.pipeline?.thinkingCueEnabled ?? true;
const THINKING_CUE_TEXT         = config.pipeline?.thinkingCueText ?? 'One moment...';

export class VoicePipeline {
  constructor(discordClient) {
    this._client    = discordClient;
    this._gateway   = new GatewayClient({ onAgentResponse: (text) => this._onAgentResponse(text) });
    this._voice     = new DiscordVoiceManager({
      client:       discordClient,
      onUtterance:  (pcm) => this._onUtterance(pcm),
    });

    // State
    this._queue           = [];    // pending utterances while speaking
    this._processing      = false; // true while ASR/LLM in flight
    this._agentResolve    = null;  // resolve() for pending agent response
    this._utteranceLog    = [];    // timestamps for rate limiting (rolling 60s)
  }

  /** Start the pipeline — connects gateway, joins VC. */
  async start() {
    await this._gateway.connect();
    await this._voice.join();
    console.log('[Pipeline] VoiceOps pipeline running. Listening for Operator.');
  }

  /** Called by DiscordVoiceManager when an utterance PCM buffer is ready. */
  async _onUtterance(pcmBuffer) {
    // Rate limit check
    const now = Date.now();
    this._utteranceLog = this._utteranceLog.filter(t => now - t < 60_000);
    if (this._utteranceLog.length >= MAX_UTTERANCES_PER_MINUTE) {
      console.warn('[Pipeline] Rate limit hit — utterance discarded');
      return;
    }
    this._utteranceLog.push(now);

    // Queue while a response is being processed or played
    if (this._processing || this._voice.isPlaying) {
      console.log('[Pipeline] Busy — queueing utterance');
      this._queue.push(pcmBuffer);
      return;
    }

    await this._processUtterance(pcmBuffer);
  }

  async _processUtterance(pcmBuffer) {
    this._processing = true;
    try {
      // Step 1: ASR
      const transcript = await transcribe(pcmBuffer);
      if (!transcript) {
        console.log('[Pipeline] Empty/silent transcript — skipping');
        return;
      }

      console.log(`[Pipeline] Utterance: "${transcript}"`);

      // Step 2: Optional "thinking" cue to mask LLM latency
      if (THINKING_CUE_ENABLED) {
        const cueWav = await synthesize(THINKING_CUE_TEXT).catch(() => null);
        if (cueWav) await this._voice.speak(cueWav);
      }

      // Step 3: Send to OpenClaw Gateway and wait for response
      const agentText = await this._gateway.sendVoiceTurn(transcript);
      if (!agentText) {
        console.warn('[Pipeline] No agent response received');
        return;
      }

      // Step 4: TTS synthesis (kokoro-js)
      console.log(`[Pipeline] Synthesizing: "${agentText.slice(0, 80)}..."`);
      const wavBuffer = await synthesize(agentText);
      if (!wavBuffer) {
        console.warn('[Pipeline] TTS returned null');
        return;
      }

      // Step 5: Play response
      await this._voice.speak(wavBuffer);

    } catch (err) {
      console.error('[Pipeline] Error processing utterance:', err.message);
    } finally {
      this._processing = false;

      // Drain queue
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        setImmediate(() => this._processUtterance(next));
      }
    }
  }

  /** Callback from GatewayClient when a streaming chat event arrives. */
  _onAgentResponse(text) {
    // sendVoiceTurn() already awaits the res response; this handles push events
    // from other channels that might need routing. Currently a no-op.
  }

  /** Graceful shutdown. */
  async stop() {
    console.log('[Pipeline] Shutting down...');
    this._voice.leave();
    this._gateway.close();
  }
}
