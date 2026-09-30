import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import '../scripts/test-helpers/voiceops-test-config.mjs';

const { config } = await import('../src/config.mjs');
const { synthesize } = await import('../src/tts.mjs');
const realSpawn = childProcess.spawn;
const originalConfig = { ...config.tts };

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  Object.assign(config.tts, originalConfig);
});

function stubSpawn(implementation) {
  const mocked = mock.method(childProcess, 'spawn', implementation);
  syncBuiltinESMExports();
  return mocked;
}

function fakeWorker() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = mock.fn();
  proc.stdin.end = mock.fn();
  proc.kill = mock.fn(signal => {
    queueMicrotask(() => proc.emit('close', null, signal));
    return true;
  });
  return proc;
}

function wavBuffer() {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  return wav;
}

function assertClean(proc, signal) {
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(proc.stdout.listenerCount('data'), 0);
  assert.equal(proc.stderr.listenerCount('data'), 0);
  assert.equal(proc.stdin.listenerCount('error'), 0);
  assert.equal(proc.listenerCount('error'), 0);
  assert.equal(proc.listenerCount('close'), 0);
}

test('pre-aborted synthesis never launches a worker', async () => {
  const spawn = stubSpawn(() => { throw new Error('must not spawn'); });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(synthesize('Hello.', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort kills an active synthesis and removes listeners', async () => {
  const proc = fakeWorker();
  stubSpawn(() => proc);
  const controller = new AbortController();
  const reason = new Error('Turn stopped');
  const result = synthesize('Hello.', { signal: controller.signal });
  const rejected = assert.rejects(result, err => err === reason);

  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(reason);
  // A pipe can report EPIPE while the killed worker is closing.
  proc.stdin.emit('error', new Error('EPIPE'));
  await rejected;

  assert.equal(proc.kill.mock.callCount(), 1);
  assert.deepEqual(proc.kill.mock.calls[0].arguments, ['SIGKILL']);
  assertClean(proc, controller.signal);
});

test('abort arriving during spawn is handled before writing text', async () => {
  const proc = fakeWorker();
  const controller = new AbortController();
  stubSpawn(() => {
    controller.abort();
    return proc;
  });

  await assert.rejects(synthesize('Hello.', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(proc.stdin.write.mock.callCount(), 0);
  assert.equal(proc.kill.mock.callCount(), 1);
  assertClean(proc, controller.signal);
});

for (const code of [0, 7]) {
  test(`successful synthesis with worker exit ${code} removes the abort listener`, async () => {
    const proc = fakeWorker();
    stubSpawn(() => proc);
    const controller = new AbortController();
    const result = synthesize('Hello.', { signal: controller.signal });
    const wav = wavBuffer();
    proc.stdout.emit('data', wav);
    proc.exitCode = code;
    proc.emit('close', code, null);

    assert.deepEqual(await result, wav);
    controller.abort();
    assert.equal(proc.kill.mock.callCount(), 0);
    assertClean(proc, controller.signal);
  });
}

for (const scenario of [
  { name: 'invalid WAV', finish: proc => proc.emit('close', 0, null), error: /valid WAV/ },
  { name: 'nonzero exit', finish: proc => proc.emit('close', 1, null), error: /exited 1/ },
  { name: 'signal exit', finish: proc => proc.emit('close', null, 'SIGTERM'), error: /exited SIGTERM/ },
  {
    name: 'spawn failure',
    finish: proc => {
      proc.emit('error', new Error('not found'));
      proc.emit('close', -2, null);
    },
    error: /spawn failed: not found/,
  },
]) {
  test(`${scenario.name} rejects and removes the abort listener`, async () => {
    const proc = fakeWorker();
    stubSpawn(() => proc);
    const controller = new AbortController();
    const result = synthesize('Hello.', { signal: controller.signal });
    scenario.finish(proc);

    await assert.rejects(result, scenario.error);
    assertClean(proc, controller.signal);
  });
}

test('output limit kills the worker and cleans up cancellation', async () => {
  const proc = fakeWorker();
  stubSpawn(() => proc);
  config.tts.maxOutputBytes = 4;
  const controller = new AbortController();
  const result = synthesize('Hello.', { signal: controller.signal });
  proc.stdout.emit('data', Buffer.alloc(5));

  await assert.rejects(result, /output exceeded 4 bytes/);
  assert.equal(proc.kill.mock.callCount(), 1);
  assertClean(proc, controller.signal);
});

test('timeout kills the worker and cleans up cancellation', async () => {
  const proc = fakeWorker();
  stubSpawn(() => proc);
  config.tts.timeoutMs = 1;
  const controller = new AbortController();

  await assert.rejects(synthesize('Hello.', { signal: controller.signal }), /timed out after 1ms/);
  assert.equal(proc.kill.mock.callCount(), 1);
  assertClean(proc, controller.signal);
});

test('synchronous stdin failure kills the worker and cleans up cancellation', async () => {
  const proc = fakeWorker();
  proc.stdin.write = () => { throw new Error('stdin write failed'); };
  stubSpawn(() => proc);
  const controller = new AbortController();

  await assert.rejects(synthesize('Hello.', { signal: controller.signal }), /stdin write failed/);
  assert.equal(proc.kill.mock.callCount(), 1);
  assertClean(proc, controller.signal);
});

test('synthesis abort actually terminates a subprocess without loading the model', { timeout: 5000 }, async t => {
  let proc;
  stubSpawn((_command, _args, options) => {
    proc = realSpawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], options);
    return proc;
  });
  const controller = new AbortController();
  const result = synthesize('Hello.', { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  t.after(() => proc.kill('SIGKILL'));
  const closed = once(proc, 'close');
  await once(proc.stdout, 'data');

  controller.abort();
  await rejected;
  const [code, signal] = await closed;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
  assert.equal(proc.killed, true);
  assertClean(proc, controller.signal);
});
