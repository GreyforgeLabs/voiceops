import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../scripts/test-helpers/voiceops-test-config.mjs';
const { VoicePipeline } = await import('../src/pipeline.mjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 30; i++) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), 'expected scheduler milestone');
}
function fixture({ synthesize, play, response = 'First. Second. Third.', Pipeline = VoicePipeline } = {}) {
  const synthesis = [], playback = [], holds = [];
  let active = 0, maxActive = 0, snapshot, releasing = false;
  const voice = {
    get isPlaying() { return active > 0; },
    async speak(wav, { signal, onStart } = {}) {
      const text = wav.toString();
      playback.push(text); active++; maxActive = Math.max(maxActive, active); onStart?.();
      try {
        if (play) await play(text, signal);
        else if (!releasing) { const hold = deferred(); holds.push(hold); signal?.addEventListener('abort', hold.resolve, { once: true }); await hold.promise; }
      } finally { active--; }
    },
    leave() {},
  };
  const gateway = {
    async sendVoiceTurn(_text, { onTextSnapshot }) { snapshot = onTextSnapshot; onTextSnapshot(response + ' '); return response; },
    close() {},
  };
  const pipeline = new Pipeline(null, {
    voice, gateway, transcribeAudio: async () => 'Question?',
    synthesizeAudio: async (text, options) => { synthesis.push(text); return synthesize ? synthesize(text, options) : Buffer.from(text); },
  });
  return { pipeline, synthesis, playback, holds, releaseAll() { releasing = true; for (const hold of holds) hold.resolve(); }, get maxActive() { return maxActive; }, snapshot: (...args) => snapshot(...args) };
}

test('prefetches exactly one chunk during blocked playback, then plays in order', { timeout: 2000 }, async () => {
  const f = fixture();
  const done = f.pipeline._processUtterance(Buffer.alloc(320));
  try {
    await until(() => f.playback.length === 1);
    await until(() => f.synthesis.length === 2);
    await tick();
    assert.deepEqual(f.synthesis, ['First.', 'Second.']);
    assert.deepEqual(f.playback, ['First.']);
    f.holds[0].resolve();
    await until(() => f.playback.length === 2);
    await until(() => f.synthesis.length === 3);
    assert.deepEqual(f.playback, ['First.', 'Second.']);
    f.holds[1].resolve();
    await until(() => f.playback.length === 3);
    f.holds[2].resolve(); await done;
    assert.equal(f.maxActive, 1);
  } finally { await f.pipeline.stop(); f.releaseAll(); await done; }
});

test('keeps one synthesis active and handles slow synthesis without reordered playback', { timeout: 2000 }, async () => {
  const gates = [], f = fixture({ synthesize: async text => { const gate = deferred(); gates.push(gate); await gate.promise; return Buffer.from(text); } });
  const done = f.pipeline._processUtterance(Buffer.alloc(320));
  await until(() => gates.length === 1); await tick(); assert.equal(f.synthesis.length, 1);
  gates[0].resolve(); await until(() => f.playback.length === 1 && gates.length === 2);
  f.holds[0].resolve(); await tick(); assert.equal(f.playback.length, 1); assert.equal(gates.length, 2);
  gates[1].resolve(); await until(() => f.playback.length === 2 && gates.length === 3);
  gates[2].resolve(); f.holds[1].resolve(); await until(() => f.playback.length === 3);
  f.holds[2].resolve(); await done; assert.equal(f.maxActive, 1);
});

test('synthesis failure, null and empty audio do not block subsequent chunks', { timeout: 2000 }, async () => {
  const f = fixture({ response: 'Fail. Null. Empty. Good.', play: async () => {}, synthesize: async text => {
    if (text === 'Fail.') throw new Error('synthetic failure');
    if (text === 'Null.') return null;
    return Buffer.from(text === 'Empty.' ? '' : text);
  } });
  await f.pipeline._processUtterance(Buffer.alloc(320));
  assert.deepEqual(f.playback, ['Good.']); assert.equal(f.synthesis.length, 4);
});

test('playback failure does not strand the prefetched chunk', { timeout: 2000 }, async () => {
  const f = fixture({ play: async text => { if (text === 'First.') throw new Error('player failure'); } });
  await f.pipeline._processUtterance(Buffer.alloc(320));
  assert.deepEqual(f.playback, ['First.', 'Second.', 'Third.']); assert.equal(f.maxActive, 1);
});

test('shutdown drops prefetched and queued speech, ignores new utterances and late snapshots', { timeout: 2000 }, async () => {
  const f = fixture(); const done = f.pipeline._onUtterance(Buffer.alloc(320));
  await until(() => f.synthesis.length === 2);
  await f.pipeline._onUtterance(Buffer.alloc(320)); assert.equal(f.pipeline._queue.length, 1);
  await f.pipeline.stop(); await done;
  f.snapshot('First. Second. Third. Late. ');
  await f.pipeline._onUtterance(Buffer.alloc(320)); await tick();
  assert.deepEqual(f.playback, ['First.']); assert.equal(f.synthesis.length, 2);
  assert.equal(f.pipeline._queue.length, 0); assert.equal(f.pipeline._processing, false);
});

test('shutdown during synthesis discards late audio from a non-cooperative synthesizer', { timeout: 2000 }, async () => {
  const gate = deferred(); const f = fixture({ synthesize: async text => { await gate.promise; return Buffer.from(text); } });
  const done = f.pipeline._processUtterance(Buffer.alloc(320));
  await until(() => f.synthesis.length === 1); await f.pipeline.stop(); gate.resolve(); await done;
  assert.deepEqual(f.playback, []); assert.deepEqual(f.synthesis, ['First.']);
});

test('new utterances remain queued until all prior response audio has finished', { timeout: 2000 }, async () => {
  const f = fixture({ response: 'First. Second.' }); const done = f.pipeline._onUtterance(Buffer.alloc(320));
  await until(() => f.synthesis.length === 2); await f.pipeline._onUtterance(Buffer.alloc(320));
  assert.equal(f.pipeline._queue.length, 1);
  f.holds[0].resolve(); await until(() => f.playback.length === 2); await tick(); assert.equal(f.synthesis.length, 2);
  f.holds[1].resolve(); await done; await until(() => f.playback.length === 3);
  f.holds[2].resolve(); await until(() => f.playback.length === 4); f.holds[3].resolve();
  await until(() => !f.pipeline._processing); assert.equal(f.maxActive, 1);
});

test('oversized snapshots cannot build an unbounded speech queue', { timeout: 2000 }, async () => {
  const f = fixture({ response: 'Chunk. '.repeat(1000), play: async () => {} });
  await f.pipeline._processUtterance(Buffer.alloc(320)); assert.deepEqual(f.synthesis, []);
});

test('thinking cue serializes synthesis and playback while allowing one response prefetch', { timeout: 2000 }, async () => {
  const { config } = await import('../src/config.mjs');
  const previous = config.pipeline.thinkingCueEnabled;
  config.pipeline.thinkingCueEnabled = true;
  const { VoicePipeline: CuePipeline } = await import('../src/pipeline.mjs?cue-test');
  config.pipeline.thinkingCueEnabled = previous;
  const cue = config.pipeline.thinkingCueText;
  const synthesisGate = deferred();
  const f = fixture({ Pipeline: CuePipeline, synthesize: async text => {
    if (text === cue) await synthesisGate.promise;
    return Buffer.from(text);
  } });
  const done = f.pipeline._processUtterance(Buffer.alloc(320));
  try {
    await until(() => f.synthesis.length === 1); await tick(); assert.deepEqual(f.synthesis, [cue]);
    synthesisGate.resolve(); await until(() => f.playback.length === 1 && f.synthesis.length === 2);
    await tick(); assert.deepEqual(f.playback, [cue]); assert.deepEqual(f.synthesis, [cue, 'First.']);
    f.holds[0].resolve(); await until(() => f.playback.length === 2 && f.synthesis.length === 3);
    assert.equal(f.maxActive, 1);
  } finally { f.releaseAll(); await done; }
});

test('completed turns reject late gateway callbacks', { timeout: 2000 }, async () => {
  const f = fixture({ response: 'First.', play: async () => {} });
  await f.pipeline._processUtterance(Buffer.alloc(320));
  f.snapshot('First. Late. '); await tick(); assert.deepEqual(f.synthesis, ['First.']);
});

test('a burst of sentences cannot outrun playback backpressure', { timeout: 2000 }, async () => {
  const f = fixture({ response: Array.from({ length: 150 }, (_, i) => `${i}.`).join(' ') });
  const done = f.pipeline._processUtterance(Buffer.alloc(320));
  try {
    await until(() => f.synthesis.length === 2); await tick();
    assert.equal(f.synthesis.length, 2); assert.equal(f.playback.length, 1);
  } finally { f.releaseAll(); await done; }
  assert.equal(f.playback.length, 150); assert.equal(f.maxActive, 1);
});

test('shutdown during transcription never starts a gateway turn', { timeout: 2000 }, async () => {
  const gate = deferred(); let calls = 0;
  const pipeline = new VoicePipeline(null, {
    transcribeAudio: () => gate.promise,
    synthesizeAudio: async () => { throw new Error('unexpected synthesis'); },
    gateway: { sendVoiceTurn() { calls++; }, close() {} },
    voice: { leave() {}, get isPlaying() { return false; } },
  });
  const done = pipeline._onUtterance(Buffer.alloc(320));
  await pipeline.stop(); gate.resolve('Question?'); await done;
  assert.equal(calls, 0); assert.equal(pipeline._processing, false);
});
