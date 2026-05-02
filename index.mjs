import { Client, GatewayIntentBits } from 'discord.js';
import { VoicePipeline } from './src/pipeline.mjs';
import { config } from './src/config.mjs';

// ── Discord client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// ── Pipeline instance ─────────────────────────────────────────────
let pipeline = null;

client.once('ready', async () => {
  console.log(`[VoiceOps] Logged in as ${client.user.tag}`);
  console.log(`[VoiceOps] Re-invite URL: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=3145728`);

  // Verify bot is still a member of the target guild before doing anything
  try {
    await client.guilds.fetch(config.guildId);
    console.log(`[VoiceOps] Guild membership confirmed: ${config.guildId}`);
  } catch (err) {
    console.error(`[VoiceOps] CRITICAL: Bot is not a member of target guild ${config.guildId}. Error: ${err.message}`);
    console.error(`[VoiceOps] Use the re-invite URL above to add the bot back to the server.`);
    process.exit(1);
  }

  try {
    pipeline = new VoicePipeline(client);
    await pipeline.start();
  } catch (err) {
    console.error('[VoiceOps] Startup failed:', err.message);
    process.exit(1);
  }
});

// Fired when bot is removed from a guild (kicked, banned, or guild deleted)
client.on('guildDelete', (guild) => {
  const ts = new Date().toISOString();
  if (guild.id === config.guildId) {
    console.error(`[VoiceOps] CRITICAL [${ts}] Bot was removed from target guild ${guild.id} ("${guild.name ?? 'unknown'}"). Manual re-invite required.`);
    console.error(`[VoiceOps] Re-invite URL: https://discord.com/oauth2/authorize?client_id=${client.user?.id}&scope=bot&permissions=3145728`);
    (pipeline ? pipeline.stop() : Promise.resolve())
      .catch(() => {})
      .finally(() => { client.destroy(); process.exit(1); });
  } else {
    console.warn(`[VoiceOps] Removed from non-target guild ${guild.id} - ignoring.`);
  }
});

// Fired when Discord marks a guild as unavailable (outage, not a kick)
client.on('guildUnavailable', (guild) => {
  if (guild.id === config.guildId) {
    console.warn(`[VoiceOps] Target guild ${guild.id} is temporarily unavailable (Discord outage). Waiting for it to come back.`);
  }
});

// ── Graceful shutdown ─────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[VoiceOps] ${signal} received - shutting down gracefully...`);
  if (pipeline) await pipeline.stop().catch(() => {});
  client.destroy();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[VoiceOps] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[VoiceOps] Unhandled rejection:', reason);
});

// ── Start ─────────────────────────────────────────────────────────
console.log('[VoiceOps] Starting...');
console.log('[VoiceOps] Built by Greyforge Labs - https://greyforge.tech');
console.log(`[VoiceOps] Guild:         ${config.guildId}`);
console.log(`[VoiceOps] Voice channel: ${config.voiceChannelId}`);
console.log(`[VoiceOps] Operator ID:   ${config.operatorUserId}`);
console.log(`[VoiceOps] Gateway URL:   ${config.gatewayUrl}`);
console.log(`[VoiceOps] TTS voice:     ${config.tts?.voice}`);
console.log('');

client.login(config.discordToken);
