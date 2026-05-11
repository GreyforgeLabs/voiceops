import { readFileSync } from 'fs';

const DEFAULTS = Object.freeze({
  gateway: {
    port: 18789,
    sessionKey: 'agent:main:voice:user',
    scopes: ['operator'],
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 15_000,
    maxMessageBytes: 256 * 1024,
    allowInsecureRemote: false,
  },
  tts: {
    voice: 'af_bella',
    speed: 1.0,
    timeoutMs: 30_000,
    maxInputChars: 2_000,
    maxOutputBytes: 12 * 1024 * 1024,
    modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  },
  vad: {
    silenceDurationMs: 800,
    minUtteranceDurationMs: 500,
    rmsThreshold: 0.008,
  },
  asr: {
    model: 'whisper-1',
    language: 'en',
    timeoutMs: 30_000,
  },
  pipeline: {
    maxUtteranceDurationMs: 30_000,
    utterancesPerMinuteLimit: 20,
    maxQueuedUtterances: 8,
    thinkingCueEnabled: true,
    thinkingCueText: 'Let me think about that...',
  },
  privacy: {
    logTranscripts: false,
    logAgentResponses: false,
  },
});

const DISCORD_ID_RE = /^\d{17,20}$/;
const PLACEHOLDER_RE = /^YOUR_[A-Z0-9_]+$/;

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to load config at ${path}: ${e.message}`);
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER_RE.test(value.trim());
}

function envBool(name) {
  const value = process.env[name];
  if (value == null || value === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`${name}: expected boolean value (true/false or 1/0)`);
}

function stringValue(value, { name, defaultValue, maxLength = 256, pattern } = {}) {
  const raw = value ?? defaultValue;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`voiceops.config.json: ${name} must be a non-empty string`);
  }
  const normalized = raw.trim();
  if (isPlaceholder(normalized)) {
    throw new Error(`voiceops.config.json: ${name} is still a placeholder`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`voiceops.config.json: ${name} exceeds ${maxLength} characters`);
  }
  if (pattern && !pattern.test(normalized)) {
    throw new Error(`voiceops.config.json: ${name} contains invalid characters`);
  }
  return normalized;
}

function optionalString(value, { name, defaultValue, maxLength = 256, pattern } = {}) {
  if (value == null || value === '') return defaultValue;
  return stringValue(value, { name, maxLength, pattern });
}

function numberValue(value, { name, defaultValue, min, max, integer = false }) {
  const raw = value ?? defaultValue;
  const num = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(num) || num < min || num > max || (integer && !Number.isInteger(num))) {
    const kind = integer ? 'integer' : 'number';
    const article = integer ? 'an' : 'a';
    throw new Error(`voiceops.config.json: ${name} must be ${article} ${kind} from ${min} to ${max}`);
  }
  return num;
}

function booleanValue(value, { name, defaultValue }) {
  const raw = value ?? defaultValue;
  if (typeof raw !== 'boolean') {
    throw new Error(`voiceops.config.json: ${name} must be true or false`);
  }
  return raw;
}

function stringArray(value, { name, defaultValue, maxItems = 20, maxLength = 64 }) {
  const raw = value ?? defaultValue;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > maxItems) {
    throw new Error(`voiceops.config.json: ${name} must be a non-empty array with at most ${maxItems} entries`);
  }
  return raw.map((item, index) =>
    stringValue(item, {
      name: `${name}[${index}]`,
      maxLength,
      pattern: /^[A-Za-z0-9:._/-]+$/,
    })
  );
}

function discordId(value, name) {
  const id = stringValue(value, { name, maxLength: 20 });
  if (!DISCORD_ID_RE.test(id)) {
    throw new Error(`voiceops.config.json: ${name} must be a Discord snowflake ID`);
  }
  return id;
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host.startsWith('127.');
}

function gatewayUrl(value, allowInsecureRemote) {
  const url = stringValue(value, { name: 'gateway.url', maxLength: 512 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`voiceops.config.json: gateway.url is invalid: ${err.message}`);
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('voiceops.config.json: gateway.url must use ws:// or wss://');
  }

  if (parsed.protocol === 'ws:' && !allowInsecureRemote && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'voiceops.config.json: remote gateway.url must use wss://. ' +
      'Set gateway.allowInsecureRemote=true only for an explicitly trusted private network.'
    );
  }

  return parsed.toString();
}

function loadConfig() {
  const configPath = process.env.VOICEOPS_CONFIG_PATH ?? new URL('../voiceops.config.json', import.meta.url).pathname;
  const voiceJson = load(configPath);

  const gatewayPort = numberValue(voiceJson.gateway?.port, {
    name: 'gateway.port',
    defaultValue: DEFAULTS.gateway.port,
    min: 1,
    max: 65_535,
    integer: true,
  });
  const allowInsecureRemote = envBool('VOICEOPS_ALLOW_INSECURE_REMOTE_GATEWAY')
    ?? booleanValue(voiceJson.gateway?.allowInsecureRemote, {
      name: 'gateway.allowInsecureRemote',
      defaultValue: DEFAULTS.gateway.allowInsecureRemote,
    });

  const loadedConfig = {
    discordToken: process.env.VOICEOPS_DISCORD_TOKEN ?? voiceJson.discord?.token,
    guildId: discordId(voiceJson.guildId, 'guildId'),
    operatorUserId: discordId(voiceJson.operatorUserId, 'operatorUserId'),
    voiceChannelId: discordId(voiceJson.voiceChannelId, 'voiceChannelId'),

    gatewayUrl: gatewayUrl(
      process.env.VOICEOPS_GATEWAY_URL ?? voiceJson.gateway?.url ?? `ws://127.0.0.1:${gatewayPort}`,
      allowInsecureRemote
    ),
    gatewayToken: process.env.VOICEOPS_GATEWAY_TOKEN ?? voiceJson.gateway?.token,
    gatewayScopes: stringArray(voiceJson.gateway?.scopes, {
      name: 'gateway.scopes',
      defaultValue: DEFAULTS.gateway.scopes,
    }),
    voiceSessionKey: stringValue(voiceJson.gateway?.sessionKey, {
      name: 'gateway.sessionKey',
      defaultValue: DEFAULTS.gateway.sessionKey,
      maxLength: 128,
      pattern: /^[A-Za-z0-9:._/-]+$/,
    }),

    openaiApiKey: process.env.OPENAI_API_KEY ?? voiceJson.asr?.openaiApiKey,

    gateway: {
      port: gatewayPort,
      requestTimeoutMs: numberValue(voiceJson.gateway?.requestTimeoutMs, {
        name: 'gateway.requestTimeoutMs',
        defaultValue: DEFAULTS.gateway.requestTimeoutMs,
        min: 1_000,
        max: 300_000,
        integer: true,
      }),
      connectTimeoutMs: numberValue(voiceJson.gateway?.connectTimeoutMs, {
        name: 'gateway.connectTimeoutMs',
        defaultValue: DEFAULTS.gateway.connectTimeoutMs,
        min: 1_000,
        max: 120_000,
        integer: true,
      }),
      maxMessageBytes: numberValue(voiceJson.gateway?.maxMessageBytes, {
        name: 'gateway.maxMessageBytes',
        defaultValue: DEFAULTS.gateway.maxMessageBytes,
        min: 1_024,
        max: 4 * 1024 * 1024,
        integer: true,
      }),
      allowInsecureRemote,
    },
    tts: {
      voice: stringValue(voiceJson.tts?.voice, {
        name: 'tts.voice',
        defaultValue: DEFAULTS.tts.voice,
        maxLength: 32,
        pattern: /^[a-z]{2}_[a-z0-9]+$/,
      }),
      speed: numberValue(voiceJson.tts?.speed, {
        name: 'tts.speed',
        defaultValue: DEFAULTS.tts.speed,
        min: 0.5,
        max: 2,
      }),
      timeoutMs: numberValue(voiceJson.tts?.timeoutMs, {
        name: 'tts.timeoutMs',
        defaultValue: DEFAULTS.tts.timeoutMs,
        min: 1_000,
        max: 120_000,
        integer: true,
      }),
      maxInputChars: numberValue(voiceJson.tts?.maxInputChars, {
        name: 'tts.maxInputChars',
        defaultValue: DEFAULTS.tts.maxInputChars,
        min: 1,
        max: 10_000,
        integer: true,
      }),
      maxOutputBytes: numberValue(voiceJson.tts?.maxOutputBytes, {
        name: 'tts.maxOutputBytes',
        defaultValue: DEFAULTS.tts.maxOutputBytes,
        min: 44,
        max: 128 * 1024 * 1024,
        integer: true,
      }),
      modelId: stringValue(voiceJson.tts?.modelId, {
        name: 'tts.modelId',
        defaultValue: DEFAULTS.tts.modelId,
        maxLength: 256,
        pattern: /^[A-Za-z0-9._~:/@-]+$/,
      }),
    },
    vad: {
      silenceDurationMs: numberValue(voiceJson.vad?.silenceDurationMs, {
        name: 'vad.silenceDurationMs',
        defaultValue: DEFAULTS.vad.silenceDurationMs,
        min: 100,
        max: 5_000,
        integer: true,
      }),
      minUtteranceDurationMs: numberValue(voiceJson.vad?.minUtteranceDurationMs, {
        name: 'vad.minUtteranceDurationMs',
        defaultValue: DEFAULTS.vad.minUtteranceDurationMs,
        min: 100,
        max: 10_000,
        integer: true,
      }),
      rmsThreshold: numberValue(voiceJson.vad?.rmsThreshold, {
        name: 'vad.rmsThreshold',
        defaultValue: DEFAULTS.vad.rmsThreshold,
        min: 0,
        max: 1,
      }),
    },
    asr: {
      openaiApiKey: process.env.OPENAI_API_KEY ?? voiceJson.asr?.openaiApiKey,
      model: stringValue(voiceJson.asr?.model, {
        name: 'asr.model',
        defaultValue: DEFAULTS.asr.model,
        maxLength: 64,
        pattern: /^[A-Za-z0-9._:-]+$/,
      }),
      language: optionalString(voiceJson.asr?.language, {
        name: 'asr.language',
        defaultValue: DEFAULTS.asr.language,
        maxLength: 16,
        pattern: /^[A-Za-z-]+$/,
      }),
      timeoutMs: numberValue(voiceJson.asr?.timeoutMs, {
        name: 'asr.timeoutMs',
        defaultValue: DEFAULTS.asr.timeoutMs,
        min: 1_000,
        max: 300_000,
        integer: true,
      }),
    },
    pipeline: {
      maxUtteranceDurationMs: numberValue(voiceJson.pipeline?.maxUtteranceDurationMs, {
        name: 'pipeline.maxUtteranceDurationMs',
        defaultValue: DEFAULTS.pipeline.maxUtteranceDurationMs,
        min: 1_000,
        max: 300_000,
        integer: true,
      }),
      utterancesPerMinuteLimit: numberValue(voiceJson.pipeline?.utterancesPerMinuteLimit, {
        name: 'pipeline.utterancesPerMinuteLimit',
        defaultValue: DEFAULTS.pipeline.utterancesPerMinuteLimit,
        min: 1,
        max: 120,
        integer: true,
      }),
      maxQueuedUtterances: numberValue(voiceJson.pipeline?.maxQueuedUtterances, {
        name: 'pipeline.maxQueuedUtterances',
        defaultValue: DEFAULTS.pipeline.maxQueuedUtterances,
        min: 0,
        max: 100,
        integer: true,
      }),
      thinkingCueEnabled: booleanValue(voiceJson.pipeline?.thinkingCueEnabled, {
        name: 'pipeline.thinkingCueEnabled',
        defaultValue: DEFAULTS.pipeline.thinkingCueEnabled,
      }),
      thinkingCueText: stringValue(voiceJson.pipeline?.thinkingCueText, {
        name: 'pipeline.thinkingCueText',
        defaultValue: DEFAULTS.pipeline.thinkingCueText,
        maxLength: 160,
      }),
    },
    privacy: {
      logTranscripts: booleanValue(voiceJson.privacy?.logTranscripts, {
        name: 'privacy.logTranscripts',
        defaultValue: DEFAULTS.privacy.logTranscripts,
      }),
      logAgentResponses: booleanValue(voiceJson.privacy?.logAgentResponses, {
        name: 'privacy.logAgentResponses',
        defaultValue: DEFAULTS.privacy.logAgentResponses,
      }),
    },
  };

  const missing = [];
  if (!loadedConfig.discordToken || isPlaceholder(loadedConfig.discordToken)) missing.push('discord.token or VOICEOPS_DISCORD_TOKEN');
  if (!loadedConfig.gatewayToken || isPlaceholder(loadedConfig.gatewayToken)) missing.push('gateway.token or VOICEOPS_GATEWAY_TOKEN');
  if (!loadedConfig.openaiApiKey || isPlaceholder(loadedConfig.openaiApiKey)) missing.push('asr.openaiApiKey or OPENAI_API_KEY');

  if (missing.length > 0) {
    throw new Error(`voiceops.config.json: missing required secret config: ${missing.join(', ')}`);
  }

  return loadedConfig;
}

export const config = loadConfig();
