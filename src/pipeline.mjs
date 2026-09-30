import { GatewayClient }        from './gateway-client.mjs';
import { DiscordVoiceManager }  from './discord-voice.mjs';
import { transcribe }           from './asr.mjs';
import { synthesize }           from './tts.mjs';
import { config }               from './config.mjs';
import { takeSentenceChunks }   from './sentence-chunks.mjs';

const MAX_UTTERANCES_PER_MINUTE = config.pipeline.utterancesPerMinuteLimit;
const MAX_QUEUE_SIZE            = config.pipeline.maxQueuedUtterances;
const MAX_UTTERANCE_DURATION_MS = config.pipeline.maxUtteranceDurationMs;
const MAX_AGENT_TEXT_CHARS      = config.tts.maxInputChars;
const THINKING_CUE_ENABLED      = config.pipeline.thinkingCueEnabled;
const THINKING_CUE_TEXT         = config.pipeline.thinkingCueText;

export class VoicePipeline {
  constructor(discordClient, {
    gateway,
    voice,
    transcribeAudio = transcribe,
    synthesizeAudio = synthesize,
  } = {}) {
    this._client    = discordClient;
    this._gateway   = gateway ?? new GatewayClient({ onAgentResponse: (text) => this._onAgentResponse(text) });
    this._voice     = voice ?? new DiscordVoiceManager({
      client:       discordClient,
      onUtterance:  (pcm) => this._onUtterance(pcm),
    });
    this._transcribeAudio = transcribeAudio;
    this._synthesizeAudio = synthesizeAudio;

    // State
    this._queue           = [];    // pending utterances while speaking
    this._processing      = false; // true while ASR/LLM in flight
    this._agentResolve    = null;  // resolve() for pending agent response
    this._stopped         = false;
    this._activeTurn      = null;
    this._utteranceLog    = [];    // timestamps for rate limiting (rolling 60s)
  }

  /** Start the pipeline — connects gateway, joins VC. */
  async start() {
    this._stopped = false;
    await this._gateway.connect();
    await this._voice.join();
    console.log('[Pipeline] VoiceOps pipeline running. Listening for Operator.');
  }

  /** Called by DiscordVoiceManager when an utterance PCM buffer is ready. */
  async _onUtterance(pcmBuffer) {
    if (this._stopped) return;
    const utteranceDurationMs = (pcmBuffer.length / 2 / 16_000) * 1000;
    const capturedAt = performance.now();

    console.info(`[Latency] VAD end (utterance=${utteranceDurationMs.toFixed(0)}ms)`);

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
      this._queue.push({ pcmBuffer, capturedAt });
      return;
    }

    await this._processUtterance(pcmBuffer, capturedAt);
  }

  async _processUtterance(pcmBuffer, capturedAt = performance.now()) {
    if (this._stopped) return;
    this._processing = true;
    const controller = new AbortController();
    const { signal } = controller;
    this._activeTurn = controller;
    let cueSynthesisPromise = null;
    let synthesisSlot = Promise.resolve();
    let cuePlaybackPromise = null;
    let speechChain = Promise.resolve();
    let latestText = '';
    let queuedTextOffset = 0;
    let streamStopped = false;
    let acceptingSnapshots = true;
    let gatewayStartedAt = null;
    let firstDeltaLogged = false;
    let firstTtsLogged = false;
    let firstPlaybackLogged = false;

    const elapsedMs = (start) => Math.round(performance.now() - start);
    const enqueueSpeech = (text) => {
      // A chunk may synthesize when its predecessor starts playback, never
      // earlier. This keeps one TTS worker and at most one prefetched WAV,
      // while speechChain remains the sole ordered playback consumer.
      const synthesized = synthesisSlot.then(async () => {
        if (cueSynthesisPromise) await cueSynthesisPromise;
        if (signal.aborted) return null;
        const wavBuffer = await this._synthesizeAudio(text, { signal });
        if (signal.aborted) return null;
        if (!wavBuffer?.length) {
          console.warn('[Pipeline] TTS returned no audio for a response chunk');
          return null;
        }
        if (!firstTtsLogged) {
          firstTtsLogged = true;
          console.info(`[Latency] First TTS chunk ready (${elapsedMs(capturedAt)}ms after VAD end)`);
        }
        return wavBuffer;
      }).catch((err) => {
        if (!signal.aborted) console.error('[Pipeline] Response synthesis failed:', err.message);
        return null;
      });
      let releaseSlot;
      synthesisSlot = new Promise(resolve => { releaseSlot = resolve; });
      speechChain = speechChain.then(async () => {
        const wavBuffer = await synthesized;
        if (cuePlaybackPromise) {
          await cuePlaybackPromise;
          cuePlaybackPromise = null;
        }
        releaseSlot();
        if (signal.aborted || !wavBuffer) return;
        await this._voice.speak(wavBuffer, {
          signal,
          onStart: () => {
            if (firstPlaybackLogged) return;
            firstPlaybackLogged = true;
            console.info(`[Latency] First response playback started (${elapsedMs(capturedAt)}ms after VAD end)`);
          },
        });
      }).catch((err) => {
        if (!signal.aborted) console.error('[Pipeline] Response chunk failed:', err.message);
      }).finally(releaseSlot);
    };

    const consumeSnapshot = (snapshot, { flush = false } = {}) => {
      if (signal.aborted || typeof snapshot !== 'string' || !snapshot) return;
      if (snapshot.length > MAX_AGENT_TEXT_CHARS) {
        streamStopped = true;
        console.warn('[Pipeline] Agent snapshot exceeded response character limit');
        return;
      }
      if (snapshot === latestText && !flush) return;

      if (latestText && !snapshot.startsWith(latestText)) {
        const previousWithoutTrailingSpace = latestText.trimEnd();
        if (snapshot.startsWith(previousWithoutTrailingSpace)) {
          // Final snapshots are trimmed. Trailing whitespace is not speech,
          // so remove it from the queued offset when reconciling that snapshot.
          queuedTextOffset = Math.min(queuedTextOffset, previousWithoutTrailingSpace.length);
          latestText = snapshot;
        } else if (queuedTextOffset === 0) {
          latestText = snapshot;
        } else {
          let common = 0;
          while (common < latestText.length && common < snapshot.length
            && latestText[common] === snapshot[common]) common += 1;
          if (common < queuedTextOffset) {
            streamStopped = true;
            console.warn('[Pipeline] Agent revised text already queued for speech; stopping streamed output');
            return;
          }
          latestText = snapshot;
        }
      } else {
        latestText = snapshot;
      }

      if (streamStopped) return;
      const remaining = latestText.slice(queuedTextOffset);
      const { chunks, consumed } = takeSentenceChunks(remaining, { flush });
      for (const chunk of chunks) enqueueSpeech(chunk);
      queuedTextOffset += consumed;
    };

    try {
      // Step 1: ASR
      const transcript = await this._transcribeAudio(pcmBuffer);
      if (signal.aborted) return;
      if (!transcript) {
        console.log('[Pipeline] Empty/silent transcript — skipping');
        return;
      }

      if (config.privacy.logTranscripts) {
        console.log(`[Pipeline] Utterance: "${transcript}"`);
      } else {
        console.log(`[Pipeline] Utterance accepted (${transcript.length} chars)`);
      }
      console.info(`[Latency] ASR complete (${elapsedMs(capturedAt)}ms after VAD end)`);

      // Stream complete sentences into TTS while the gateway is still
      // generating the rest of its response.
      gatewayStartedAt = performance.now();
      const agentTextPromise = this._gateway.sendVoiceTurn(transcript, {
        onTextSnapshot: (snapshot, { final = false } = {}) => {
          if (!acceptingSnapshots || signal.aborted) return;
          if (!final && !firstDeltaLogged) {
            firstDeltaLogged = true;
            console.info(`[Latency] First gateway text delta (${elapsedMs(gatewayStartedAt)}ms after request, ${elapsedMs(capturedAt)}ms after VAD end)`);
          }
          if (final) return;
          consumeSnapshot(snapshot);
        },
      });

      // Step 2: Optional "thinking" cue to mask gateway latency
      if (THINKING_CUE_ENABLED) {
        cueSynthesisPromise = Promise.resolve().then(() => signal.aborted
          ? null : this._synthesizeAudio(THINKING_CUE_TEXT, { signal }))
          .catch((err) => {
            if (!signal.aborted) console.warn('[Pipeline] Thinking cue synthesis failed:', err.message);
            return null;
          });
        cuePlaybackPromise = cueSynthesisPromise
          .then((cueWav) => !signal.aborted && cueWav?.length ? this._voice.speak(cueWav, { signal }) : null)
          .catch((err) => {
            console.warn('[Pipeline] Thinking cue failed:', err.message);
            return null;
          });
      }

      // Step 3: Wait for the final response, then flush its last partial sentence.
      const agentText = await agentTextPromise;
      acceptingSnapshots = false;
      if (signal.aborted) return;
      console.info(`[Latency] Final gateway response (${elapsedMs(gatewayStartedAt)}ms after request, ${elapsedMs(capturedAt)}ms after VAD end)`);
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

      if (config.privacy.logAgentResponses) {
        console.log(`[Pipeline] Streaming response: "${agentText.slice(0, 80)}..."`);
      } else {
        console.log(`[Pipeline] Streaming agent response (${agentText.length} chars)`);
      }
      consumeSnapshot(agentText, { flush: true });
      await speechChain;

    } catch (err) {
      console.error('[Pipeline] Error processing utterance:', err.message);
    } finally {
      acceptingSnapshots = false;
      if (cuePlaybackPromise) {
        await cuePlaybackPromise;
      }
      await speechChain;
      controller.abort();
      this._activeTurn = null;
      this._processing = false;

      // Drain queue
      if (!this._stopped && this._queue.length > 0) {
        const next = this._queue.shift();
        void this._processUtterance(next.pcmBuffer, next.capturedAt);
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
    this._stopped = true;
    this._queue.length = 0;
    this._activeTurn?.abort();
    this._voice.leave();
    this._gateway.close();
  }
}
