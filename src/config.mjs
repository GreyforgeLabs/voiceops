/**
 * config.mjs — Load and merge OpenClaw global config + VoiceOps-specific config.
 *
 * Built by Greyforge Labs — https://greyforge.tech
 * https://github.com/GreyforgeLabs/voiceops
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const HOME = homedir();

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to load config at ${path}: ${e.message}`);
  }
}

function loadConfig() {
  const ocJson     = load(resolve(HOME, '.openclaw/openclaw.json'));
  const voiceJson  = load(new URL('../voiceops.config.json', import.meta.url).pathname);

  if (voiceJson.voiceChannelId === 'CONFIGURE_ME') {
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

  return {
    // Discord
    discordToken:   ocJson.channels?.discord?.token,
    guildId:        voiceJson.guildId,
    operatorUserId: voiceJson.operatorUserId,
    voiceChannelId: voiceJson.voiceChannelId,

    // OpenClaw Gateway
    gatewayPort:       ocJson.gateway?.port  ?? 18789,
    gatewayToken:      ocJson.gateway?.auth?.token,
    voiceSessionKey:   voiceJson.voiceSessionKey ?? 'agent:main:voice:user',

    // OpenAI (Whisper ASR)
    openaiApiKey:   ocJson.env?.OPENAI_API_KEY,

    // TTS
    tts: voiceJson.tts,

    // VAD
    vad: voiceJson.vad,

    // ASR
    asr: voiceJson.asr,

    // Pipeline
    pipeline: voiceJson.pipeline,
  };
}

export const config = loadConfig();
