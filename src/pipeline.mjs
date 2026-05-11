import { GatewayClient }        from './gateway-client.mjs';
import { DiscordVoiceManager }  from './discord-voice.mjs';
import { transcribe }           from './asr.mjs';
import { synthesize }           from './tts.mjs';
import { config }               from './config.mjs';

const MAX_UTTERANCES_PER_MINUTE = config.pipeline.utterancesPerMinuteLimit;
const MAX_QUEUE_SIZE            = config.pipeline.maxQueuedUtterances;
const MAX_UTTERANCE_DURATION_MS = config.pipeline.maxUtteranceDurationMs;
const MAX_AGENT_TEXT_CHARS      = config.tts.maxInputChars;
const THINKING_CUE_ENABLED      = config.pipeline.thinkingCueEnabled;
const THINKING_CUE_TEXT         = config.pipeline.thinkingCueText;

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
    const utteranceDurationMs = (pcmBuffer.length / 2 / 16_000) * 1000;

    if (utteranceDurationMs > MAX_UTTERANCE_DURATION_MS) {
      console.warn(
        `[Pipeline] Overlong utterance discarded (${utteranceDurationMs.toFixed(0)}ms > ${MAX_UTTERANCE_DURATION_MS}ms)`
      );
      return;
    }

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
      if (this._queue.length >= MAX_QUEUE_SIZE) {
        console.warn('[Pipeline] Queue full — utterance discarded');
        return;
      }
      console.log('[Pipeline] Busy — queueing utterance');
      this._queue.push(pcmBuffer);
      return;
    }

    await this._processUtterance(pcmBuffer);
  }

  async _processUtterance(pcmBuffer) {
    this._processing = true;
    let cuePlaybackPromise = null;
    try {
      // Step 1: ASR
      const transcript = await transcribe(pcmBuffer);
      if (!transcript) {
        console.log('[Pipeline] Empty/silent transcript — skipping');
        return;
      }

      if (config.privacy.logTranscripts) {
        console.log(`[Pipeline] Utterance: "${transcript}"`);
      } else {
        console.log(`[Pipeline] Utterance accepted (${transcript.length} chars)`);
      }

      // Start the gateway request immediately so the optional cue overlaps
      // gateway processing instead of delaying it.
      const agentTextPromise = this._gateway.sendVoiceTurn(transcript);

      // Step 2: Optional "thinking" cue to mask gateway latency
      if (THINKING_CUE_ENABLED) {
        cuePlaybackPromise = synthesize(THINKING_CUE_TEXT)
          .then((cueWav) => cueWav ? this._voice.speak(cueWav) : null)
          .catch((err) => {
            console.warn('[Pipeline] Thinking cue failed:', err.message);
            return null;
          });
      }

      // Step 3: Send to the configured gateway and wait for response
      const agentText = await agentTextPromise;
      if (cuePlaybackPromise) {
        await cuePlaybackPromise;
        cuePlaybackPromise = null;
      }
      if (!agentText) {
        console.warn('[Pipeline] No agent response received');
        return;
      }
      if (agentText.length > MAX_AGENT_TEXT_CHARS) {
        console.warn(
          `[Pipeline] Agent response discarded (${agentText.length} chars > ${MAX_AGENT_TEXT_CHARS} chars)`
        );
        return;
      }

      // Step 4: TTS synthesis (kokoro-js)
      if (config.privacy.logAgentResponses) {
        console.log(`[Pipeline] Synthesizing: "${agentText.slice(0, 80)}..."`);
      } else {
        console.log(`[Pipeline] Synthesizing agent response (${agentText.length} chars)`);
      }
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
      if (cuePlaybackPromise) {
        await cuePlaybackPromise;
      }
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
