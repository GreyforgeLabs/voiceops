import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const BASE_CONFIG = {
  discord: {
    token: 'YOUR_DISCORD_BOT_TOKEN',
  },
  voiceChannelId: '123456789012345678',
  guildId: '123456789012345679',
  operatorUserId: '123456789012345680',
  gateway: {
    url: 'ws://127.0.0.1:18789',
    token: 'YOUR_GATEWAY_TOKEN',
    sessionKey: 'agent:main:voice:user',
    scopes: ['operator'],
  },
  asr: {
    openaiApiKey: 'YOUR_OPENAI_API_KEY',
  },
};

function cloneConfig(config = BASE_CONFIG) {
  return JSON.parse(JSON.stringify(config));
}

function runConfig(config, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voiceops-config-'));
  const configPath = join(dir, 'voiceops.config.json');
  writeFileSync(configPath, JSON.stringify(config), 'utf8');

  try {
    return spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      [
        "import { config } from './src/config.mjs';",
        'console.log(JSON.stringify({',
        'gatewayUrl: config.gatewayUrl,',
        'allowInsecureRemote: config.gateway.allowInsecureRemote,',
        'maxMessageBytes: config.gateway.maxMessageBytes,',
        'privacy: config.privacy',
        '}));',
      ].join(''),
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        VOICEOPS_CONFIG_PATH: configPath,
        VOICEOPS_DISCORD_TOKEN: 'discord-token',
        VOICEOPS_GATEWAY_TOKEN: 'gateway-token',
        OPENAI_API_KEY: 'openai-token',
        ...extraEnv,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('config accepts a loopback ws gateway and redacts logs by default', () => {
  const result = runConfig(cloneConfig());
  assert.equal(result.status, 0, result.stderr);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.gatewayUrl, 'ws://127.0.0.1:18789/');
  assert.equal(parsed.maxMessageBytes, 262144);
  assert.deepEqual(parsed.privacy, {
    logTranscripts: false,
    logAgentResponses: false,
  });
});

test('config rejects a remote plaintext gateway by default', () => {
  const config = cloneConfig();
  config.gateway.url = 'ws://example.com:18789';

  const result = runConfig(config);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /remote gateway\.url must use wss:\/\//);
});

test('config can explicitly allow a remote plaintext gateway', () => {
  const config = cloneConfig();
  config.gateway.url = 'ws://example.com:18789';
  config.gateway.allowInsecureRemote = true;

  const result = runConfig(config);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.allowInsecureRemote, true);
});

test('config rejects invalid Discord IDs', () => {
  const config = cloneConfig();
  config.operatorUserId = 'not-a-snowflake';

  const result = runConfig(config);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operatorUserId must be a Discord snowflake ID/);
});

test('config rejects oversized gateway message limits', () => {
  const config = cloneConfig();
  config.gateway.maxMessageBytes = 999999999;

  const result = runConfig(config);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gateway\.maxMessageBytes must be an integer/);
});
