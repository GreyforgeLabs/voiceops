import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { config } from './config.mjs';

const RECONNECT_DELAY_MS   = 3000;
const PING_INTERVAL_MS     = 30_000;
const REQUEST_TIMEOUT_MS   = 60_000;

// Strip an optional signature line appended by an upstream agent.
function stripSignature(text) {
  return (text ?? '').replace(/\n\n[-\u2013\u2014][^\n]*$/, '').trim();
}

export class GatewayClient {
  constructor({ onAgentResponse } = {}) {
    this._onAgentResponse = onAgentResponse ?? (() => {});
    this._ws       = null;
    this._pending  = new Map(); // reqId → { resolve, reject, timer }
    this._chatWait = new Map(); // runId/idempotencyKey -> wait entry
    this._pingTimer    = null;
    this._reconnecting = false;
    this._sessionId    = null;
    this._closed       = false;
  }

  /** Connect and authenticate. Resolves once connected + authenticated. */
  async connect() {
    const url = config.gatewayUrl;
    console.log(`[GW] Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this._ws = ws;
      let connectId = null;
      let settled = false;

      const finishConnect = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      // v3 protocol: wait for connect.challenge, THEN send the connect req
      const sendConnect = () => {
        if (connectId) return;
        connectId = randomUUID();
        ws.send(JSON.stringify({
          type:   'req',
          id:     connectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id:       'cli',
              version:  '0.1.0',
              platform: 'linux',
              mode:     'cli',
            },
            scopes: config.gatewayScopes,
            auth: { token: config.gatewayToken },
          },
        }));
      };

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // 1. Server sends challenge → we respond with the connect req
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          sendConnect();
          return;
        }

        // 2. Connect req response (ok=true means connected)
        if (msg.type === 'res' && msg.id === connectId) {
          if (msg.ok) {
            this._sessionId = msg.payload?.server?.connId ?? msg.payload?.sessionId ?? 'unknown';
            console.log('[GW] Connected. connId:', this._sessionId);
            this._startPing();
            finishConnect(resolve);
          } else {
            finishConnect(reject, new Error(`Gateway connect failed: ${msg.error?.message ?? JSON.stringify(msg)}`));
          }
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.ready') {
          // Some versions emit connect.ready instead of / in addition to the res
          if (!this._sessionId) {
            this._sessionId = msg.payload?.sessionId ?? 'unknown';
            console.log('[GW] Connected (ready event). Session:', this._sessionId);
            this._startPing();
            finishConnect(resolve);
          }
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.error') {
          finishConnect(reject, new Error(`Gateway connect error: ${msg.payload?.message ?? 'unknown'}`));
          return;
        }

        this._handleMessage(msg);
      });

      ws.once('error', (err) => {
        if (!this._sessionId) finishConnect(reject, err);
        else {
          this._rejectInflight(new Error(`Gateway connection error: ${err.message}`));
          this._scheduleReconnect();
        }
      });

      ws.once('close', () => {
        this._stopPing();
        if (!this._closed) {
          this._rejectInflight(new Error('Gateway connection lost'));
          this._scheduleReconnect();
        }
      });
    });
  }

  /** Send a voice-sourced chat message; resolves with the final agent response text. */
  async sendVoiceTurn(text) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway is not connected');
    }

    const idempotencyKey = randomUUID();

    // chat.send returns {runId, status:'started'} immediately.
    // The actual agent text arrives via 'chat' events with state='final'.
    let entry;
    const chatPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._clearChatWait(entry);
        reject(new Error('Agent response timed out'));
      }, REQUEST_TIMEOUT_MS);
      entry = { resolve, reject, timer, keys: new Set([idempotencyKey]) };
      this._chatWait.set(idempotencyKey, entry);
    });

    // Fire the request (don't await — just need it to be accepted)
    this._request('chat.send', {
      sessionKey:     config.voiceSessionKey,
      message:        text,
      idempotencyKey,
    }).then((payload) => {
      const runId = payload?.runId ?? payload?.id;
      if (runId && entry) {
        entry.keys.add(runId);
        this._chatWait.set(runId, entry);
      }
    }).catch((err) => {
      // If the req itself fails, reject the chat promise too
      const entry = this._chatWait.get(idempotencyKey);
      if (entry) {
        this._clearChatWait(entry);
        entry.reject(err);
      }
    });

    return chatPromise;
  }

  /** Low-level RPC request. */
  _request(method, params = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway is not connected');
    }

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Gateway request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  _handleMessage(msg) {
    // Resolve pending RPC responses
    if (msg.type === 'res' && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.ok) resolve(msg.payload);
      else reject(new Error(msg.error?.message ?? 'Gateway error'));
      return;
    }

    // Route chat events to pending sendVoiceTurn promises
    if (msg.type === 'event' && msg.event === 'chat') {
      const { state, runId, idempotencyKey, message } = msg.payload ?? {};
      // Extract text from content array (v3 format)
      const rawText = message?.content?.find(c => c.type === 'text')?.text ?? '';
      const text    = stripSignature(rawText);

      if (state === 'final') {
        const entry = this._chatWait.get(runId) ?? this._chatWait.get(idempotencyKey);
        if (entry) {
          this._clearChatWait(entry);
          console.log(`[GW] Agent response: "${text.slice(0, 80)}"`);
          entry.resolve(text || null);
        } else {
          // Push-event from another channel — route to callback
          if (text) this._onAgentResponse(text);
        }
      } else if (state === 'error') {
        const entry = this._chatWait.get(runId) ?? this._chatWait.get(idempotencyKey);
        if (entry) {
          this._clearChatWait(entry);
          entry.reject(new Error('Agent error: ' + (rawText || 'unknown')));
        }
      }
    }
  }

  _clearChatWait(entry) {
    if (!entry) return;
    for (const key of entry.keys ?? []) {
      this._chatWait.delete(key);
    }
    clearTimeout(entry.timer);
  }

  _rejectInflight(error) {
    const chatEntries = new Set(this._chatWait.values());
    this._chatWait.clear();
    for (const entry of chatEntries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }

    const pendingEntries = new Set(this._pending.values());
    this._pending.clear();
    for (const entry of pendingEntries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _scheduleReconnect() {
    if (this._reconnecting || this._closed) return;
    this._reconnecting = true;
    console.log(`[GW] Disconnected. Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    setTimeout(async () => {
      this._reconnecting = false;
      try { await this.connect(); }
      catch (e) { console.error('[GW] Reconnect failed:', e.message); this._scheduleReconnect(); }
    }, RECONNECT_DELAY_MS);
  }

  close() {
    this._closed = true;
    this._stopPing();
    this._ws?.close();
    this._rejectInflight(new Error('Gateway connection closing'));
  }
}
