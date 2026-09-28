import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import '../scripts/test-helpers/voiceops-test-config.mjs';

const { GatewayClient } = await import('../src/gateway-client.mjs');

test('sendVoiceTurn exposes growing chat snapshots before the final event', async () => {
  const client = new GatewayClient();
  client._ws = { readyState: WebSocket.OPEN };
  client._request = async () => ({ runId: 'run-1' });
  const snapshots = [];

  const response = client.sendVoiceTurn('Say hello', {
    onTextSnapshot: (text, state) => snapshots.push({ text, final: state.final }),
  });
  await new Promise(resolve => setImmediate(resolve));

  client._handleMessage({
    type: 'event',
    event: 'chat',
    payload: {
      state: 'delta',
      runId: 'run-1',
      message: { content: [{ type: 'text', text: 'Hello there. ' }] },
    },
  });
  assert.deepEqual(snapshots, [{ text: 'Hello there. ', final: false }]);

  client._handleMessage({
    type: 'event',
    event: 'chat',
    payload: {
      state: 'delta',
      runId: 'run-1',
      message: { content: [{ type: 'text', text: 'Hello there. How can I help?' }] },
    },
  });
  client._handleMessage({
    type: 'event',
    event: 'chat',
    payload: {
      state: 'final',
      runId: 'run-1',
      message: { content: [{ type: 'text', text: 'Hello there. How can I help?' }] },
    },
  });

  assert.equal(await response, 'Hello there. How can I help?');
  assert.deepEqual(snapshots, [
    { text: 'Hello there. ', final: false },
    { text: 'Hello there. How can I help?', final: false },
  ]);
});
