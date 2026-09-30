import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { PassThrough } from 'node:stream';
import prism from 'prism-media';
import { AudioPlayerStatus } from '@discordjs/voice';
import '../scripts/test-helpers/voiceops-test-config.mjs';

// Keep the real voice manager and AudioResource pipeline, but replace media
// processing at its boundaries so tests need neither ffmpeg nor an Opus codec.
const originalFFmpeg = prism.FFmpeg;
const originalEncoder = prism.opus.Encoder;
class FakeFFmpeg extends PassThrough {
  static getInfo() { return { output: '' }; }
}
class FakeEncoder extends PassThrough {}
prism.FFmpeg = FakeFFmpeg;
prism.opus.Encoder = FakeEncoder;
after(() => {
  prism.FFmpeg = originalFFmpeg;
  prism.opus.Encoder = originalEncoder;
});

const { DiscordVoiceManager } = await import('../src/discord-voice.mjs');

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: AudioPlayerStatus.Idle };
    this.stopCalls = [];
    this.playCalls = [];
  }

  play(resource) {
    this.playCalls.push(resource);
    this.resource = resource;
    this.transition(AudioPlayerStatus.Buffering);
  }

  transition(status) {
    const oldState = this.state;
    this.state = { status, resource: this.resource };
    this.emit('stateChange', oldState, this.state);
    if (status === AudioPlayerStatus.Idle) {
      this.resource?.playStream.destroy();
      this.resource = null;
    }
  }

  stop(force) {
    this.stopCalls.push(force);
    if (this.state.status === AudioPlayerStatus.Idle) return false;
    this.transition(AudioPlayerStatus.Idle);
    return true;
  }
}

function voiceManager(t, { realPlayer = false } = {}) {
  const voice = new DiscordVoiceManager({ client: {}, onUtterance: async () => {} });
  if (!realPlayer) voice._player = new FakePlayer();
  voice._connection = { destroy() {} };
  t.after(() => voice.leave());
  return voice;
}

function assertClean(voice, signal) {
  assert.equal(voice._player.listenerCount('stateChange'), 0);
  assert.equal(voice._player.listenerCount('error'), 0);
  assert.equal(voice._cancelPlayback, null);
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('pre-aborted playback rejects without starting the player', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(voice.speak(Buffer.from('wav'), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(voice._player.playCalls.length, 0);
  assertClean(voice, controller.signal);
});

test('successful playback calls onStart once and cleans up listeners', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  let starts = 0;
  const result = voice.speak(Buffer.from('wav'), {
    signal: controller.signal,
    onStart: () => { starts++; },
  });
  voice._player.transition(AudioPlayerStatus.Playing);
  voice._player.transition(AudioPlayerStatus.Playing);
  voice._player.transition(AudioPlayerStatus.Idle);
  await result;

  assert.equal(starts, 1);
  assertClean(voice, controller.signal);
  controller.abort();
  assert.deepEqual(voice._player.stopCalls, []);
});

for (const state of [AudioPlayerStatus.Buffering, AudioPlayerStatus.Playing]) {
  test(`abort during ${state} force-stops playback and rejects`, async t => {
    const voice = voiceManager(t);
    const controller = new AbortController();
    const reason = new Error('Turn stopped');
    const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
    const rejected = assert.rejects(result, err => err === reason);
    voice._player.transition(state);
    const resource = voice._player.resource;

    controller.abort(reason);
    await rejected;
    assert.deepEqual(voice._player.stopCalls, [true]);
    assert.equal(resource.playStream.destroyed, true);
    assert.equal(voice.isPlaying, false);
    assertClean(voice, controller.signal);
  });
}

test('a falsy abort reason still rejects playback', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
  const rejected = assert.rejects(result, err => err === false);
  controller.abort(false);

  await rejected;
  assertClean(voice, controller.signal);
});

test('player errors reject rather than resolving on the resulting idle transition', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  const error = new Error('Audio decoder failed');
  const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
  const rejected = assert.rejects(result, err => err === error);
  voice._player.emit('error', error);

  await rejected;
  assert.deepEqual(voice._player.stopCalls, [true]);
  assertClean(voice, controller.signal);
});

test('a synchronous player failure rejects and destroys its resource', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  let resource;
  voice._player.play = value => {
    resource = value;
    throw new Error('Player failed to start');
  };

  await assert.rejects(voice.speak(Buffer.from('wav'), { signal: controller.signal }), /Player failed to start/);
  assert.equal(resource.playStream.destroyed, true);
  assertClean(voice, controller.signal);
});

test('onStart callback errors reject and stop playback', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), {
    signal: controller.signal,
    onStart: () => { throw new Error('onStart failed'); },
  });
  const rejected = assert.rejects(result, /onStart failed/);
  voice._player.transition(AudioPlayerStatus.Playing);

  await rejected;
  assert.equal(voice.isPlaying, false);
  assertClean(voice, controller.signal);
});

test('abort from onStart cannot be mistaken for successful playback', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), {
    signal: controller.signal,
    onStart: () => controller.abort(),
  });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  voice._player.transition(AudioPlayerStatus.Playing);

  await rejected;
  assert.equal(voice.isPlaying, false);
  assertClean(voice, controller.signal);
});

test('leave stops and settles active playback before destroying the connection', async t => {
  const voice = voiceManager(t);
  let destroyed = false;
  voice._connection.destroy = () => {
    assert.equal(voice.isPlaying, false);
    destroyed = true;
  };
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError', message: 'Voice channel left' });

  voice.leave();
  await rejected;
  assert.equal(destroyed, true);
  assert.equal(voice._connection, null);
  assert.deepEqual(voice._player.stopCalls, [true]);
  assertClean(voice, controller.signal);
});

test('replacement settles old playback without letting its abort stop the new audio', async t => {
  const voice = voiceManager(t);
  const controller = new AbortController();
  const oldPlayback = voice.speak(Buffer.from('old'), { signal: controller.signal });
  const rejected = assert.rejects(oldPlayback, { name: 'AbortError', message: 'Playback replaced' });
  const newPlayback = voice.speak(Buffer.from('new'));
  await rejected;
  controller.abort();

  assert.equal(voice.isPlaying, true);
  assert.deepEqual(voice._player.stopCalls, [true]);
  voice._player.transition(AudioPlayerStatus.Idle);
  await newPlayback;
  assertClean(voice, controller.signal);
});

test('real AudioPlayer force-stop on abort settles and releases the resource', async t => {
  const voice = voiceManager(t, { realPlayer: true });
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
  const resource = voice._player.state.resource;
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort();

  await rejected;
  assert.equal(voice.isPlaying, false);
  assert.equal(resource.playStream.destroyed, true);
  assertClean(voice, controller.signal);
});

test('real AudioPlayer stream errors reject and clean up playback', async t => {
  const voice = voiceManager(t, { realPlayer: true });
  const controller = new AbortController();
  const result = voice.speak(Buffer.from('wav'), { signal: controller.signal });
  const rejected = assert.rejects(result, /Audio stream failed/);
  voice._player.state.resource.playStream.emit('error', new Error('Audio stream failed'));

  await rejected;
  assert.equal(voice.isPlaying, false);
  assertClean(voice, controller.signal);
});

test('real AudioPlayer starts once and settles when stopped normally', { timeout: 3000 }, async t => {
  const voice = voiceManager(t, { realPlayer: true });
  let starts = 0;
  const started = once(voice._player, AudioPlayerStatus.Playing);
  const result = voice.speak(Buffer.from('wav'), { onStart: () => { starts++; } });
  await started;
  voice._player.stop(true);
  await result;

  assert.equal(starts, 1);
  assertClean(voice);
});
