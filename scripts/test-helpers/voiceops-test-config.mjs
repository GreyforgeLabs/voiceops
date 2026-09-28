import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const configDir = mkdtempSync(join(tmpdir(), 'voiceops-test-'));
const configPath = join(configDir, 'voiceops.config.json');
writeFileSync(configPath, JSON.stringify({
  discord: { token: 'YOUR_DISCORD_BOT_TOKEN' },
  voiceChannelId: '123456789012345678',
  guildId: '123456789012345679',
  operatorUserId: '123456789012345680',
  gateway: {
    url: 'ws://127.0.0.1:18789',
    token: 'YOUR_GATEWAY_TOKEN',
    sessionKey: 'agent:main:voice:user',
    scopes: ['operator'],
  },
  asr: { openaiApiKey: 'YOUR_OPENAI_API_KEY' },
  pipeline: { thinkingCueEnabled: false },
}), 'utf8');

process.env.VOICEOPS_CONFIG_PATH = configPath;
process.env.VOICEOPS_DISCORD_TOKEN = 'test-discord-token';
process.env.VOICEOPS_GATEWAY_TOKEN = 'test-gateway-token';
process.env.OPENAI_API_KEY = 'test-openai-token';

after(() => rmSync(configDir, { recursive: true, force: true }));
