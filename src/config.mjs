import { readFileSync } from 'fs';

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to load config at ${path}: ${e.message}`);
  }
}

function loadConfig() {
  const voiceJson = load(new URL('../voiceops.config.json', import.meta.url).pathname);

  const gatewayPort = voiceJson.gateway?.port ?? 18789;
  const loadedConfig = {
    discordToken: process.env.VOICEOPS_DISCORD_TOKEN ?? voiceJson.discord?.token,
    guildId: voiceJson.guildId,
    operatorUserId: voiceJson.operatorUserId,
    voiceChannelId: voiceJson.voiceChannelId,

    gatewayUrl: process.env.VOICEOPS_GATEWAY_URL ?? voiceJson.gateway?.url ?? `ws://127.0.0.1:${gatewayPort}`,
    gatewayToken: process.env.VOICEOPS_GATEWAY_TOKEN ?? voiceJson.gateway?.token,
    gatewayScopes: voiceJson.gateway?.scopes ?? ['operator'],
    voiceSessionKey: voiceJson.gateway?.sessionKey ?? 'agent:main:voice:user',

    openaiApiKey: process.env.OPENAI_API_KEY ?? voiceJson.asr?.openaiApiKey,

    tts: voiceJson.tts,
    vad: voiceJson.vad,
    asr: voiceJson.asr,
    pipeline: voiceJson.pipeline,
  };

  const missing = [];
  if (!loadedConfig.discordToken || loadedConfig.discordToken === 'YOUR_DISCORD_BOT_TOKEN') missing.push('discord.token or VOICEOPS_DISCORD_TOKEN');
  if (!loadedConfig.gatewayToken || loadedConfig.gatewayToken === 'YOUR_GATEWAY_TOKEN') missing.push('gateway.token or VOICEOPS_GATEWAY_TOKEN');
  if (!loadedConfig.openaiApiKey || loadedConfig.openaiApiKey === 'YOUR_OPENAI_API_KEY') missing.push('asr.openaiApiKey or OPENAI_API_KEY');

  if (voiceJson.voiceChannelId === 'YOUR_VOICE_CHANNEL_ID') {
    throw new Error(
      'voiceops.config.json: voiceChannelId is not set.\n' +
      'Right-click your Discord voice channel → Copy Channel ID and paste it in voiceops.config.json.'
    );
  }
  if (!voiceJson.operatorUserId) {
    throw new Error(
      'voiceops.config.json: operatorUserId is not set.\n' +
      'Set it to your Discord user ID (Enable Developer Mode → right-click your username → Copy User ID).'
    );
  }
  if (missing.length > 0) {
    throw new Error(`voiceops.config.json: missing required secret config: ${missing.join(', ')}`);
  }

  return loadedConfig;
}

export const config = loadConfig();
