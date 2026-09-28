import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../scripts/test-helpers/voiceops-test-config.mjs';

const { VoicePipeline } = await import('../src/pipeline.mjs');

test('starts TTS and playback on a complete sentence before gateway final', async () => {
  const events = [];
  let notifyPlaybackStarted;
  const playbackStarted = new Promise(resolve => { notifyPlaybackStarted = resolve; });

  const voice = {
    async speak(wavBuffer, { onStart } = {}) {
      events.push(`play:${wavBuffer.toString()}`);
      onStart?.();
      notifyPlaybackStarted();
    },
    get isPlaying() { return false; },
  };
  const gateway = {
    async sendVoiceTurn(_text, { onTextSnapshot }) {
      onTextSnapshot('The first sentence. ', { final: false });
      let timer;
      await Promise.race([
        playbackStarted,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('TTS waited for gateway final')), 1000);
        }),
      ]);
      clearTimeout(timer);
      events.push('gateway-final');
      onTextSnapshot('The first sentence. The second sentence.', { final: true });
      return 'The first sentence. The second sentence.';
    },
  };
  const pipeline = new VoicePipeline(null, {
    gateway,
    voice,
    transcribeAudio: async () => 'Question?',
    synthesizeAudio: async text => {
      events.push(`tts:${text}`);
      return Buffer.from(text);
    },
  });

  await pipeline._processUtterance(Buffer.alloc(320), performance.now());

  assert.deepEqual(events, [
    'tts:The first sentence.',
    'play:The first sentence.',
    'gateway-final',
    'tts:The second sentence.',
    'play:The second sentence.',
  ]);
});
