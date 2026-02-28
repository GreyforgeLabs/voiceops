/**
 * discord-voice.mjs — Discord voice channel management.
 *
 * Handles:
 *   - Joining / leaving voice channels
 *   - Subscribing to Operator's audio stream (with automatic re-subscribe after each utterance)
 *   - Opus → PCM16 decoding via prism-media
 *   - Playing TTS WAV responses via AudioPlayer
 *   - Reconnect-on-disconnect
 *
 * One-shot stream pattern (per Vulcan audit):
 *   receiver.subscribe(userId) returns a stream that ends after silence.
 *   We re-subscribe immediately on each 'end' event to stay always-listening.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  StreamType,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'stream';
import { config } from './config.mjs';

// Discord sends Opus at 48kHz — decode to 16kHz 16-bit mono for Whisper compatibility
const OPUS_DECODE_OPTS = {
  rate:      16000,
  channels:  1,
  frameSize: 960,   // 60ms at 16kHz
};

// Minimum utterance buffer size to avoid re-subscribing before data arrives
const MIN_PCM_BYTES = (16000 * 2 * (config.vad?.minUtteranceDurationMs ?? 500)) / 1000;

export class DiscordVoiceManager {
  constructor({ client, onUtterance }) {
    this._client      = client;
    this._onUtterance = onUtterance; // async (pcmBuffer: Buffer) => void
    this._connection  = null;
    this._player      = createAudioPlayer();
    this._listening   = false;
  }

  /** Join the configured voice channel. */
  async join() {
    const guild = await this._client.guilds.fetch(config.guildId);
    const channel = guild.channels.cache.get(config.voiceChannelId)
      ?? await guild.channels.fetch(config.voiceChannelId);

    if (!channel) throw new Error(`Voice channel ${config.voiceChannelId} not found in guild ${config.guildId}`);

    console.log(`[VC] Joining #${channel.name}...`);

    this._connection = joinVoiceChannel({
      channelId:  channel.id,
      guildId:    guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:   false, // must be false to receive audio
      selfMute:   false,
    });

    this._connection.subscribe(this._player);

    // Wait for Ready state
    await entersState(this._connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[VC] Connected to #${channel.name}`);

    // Reconnect handler
    this._connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('[VC] Disconnected. Attempting reconnect...');
      try {
        await Promise.race([
          entersState(this._connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this._connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        console.log('[VC] Reconnected to voice channel.');
      } catch {
        console.error('[VC] Reconnect failed. Destroying connection.');
        this._connection.destroy();
        this._connection = null;
        this._scheduleVoiceRejoin();
      }
    });

    // Begin listening
    this._startListening();
  }

  /** Play a WAV buffer through the voice channel. */
  async speak(wavBuffer) {
    if (!this._connection) {
      console.warn('[VC] speak() called but not connected');
      return;
    }

    // Wrap the WAV buffer in a readable stream
    const stream   = Readable.from(wavBuffer);
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });

    this._player.play(resource);

    return new Promise((resolve) => {
      const onIdle = (oldState, newState) => {
        if (newState.status === AudioPlayerStatus.Idle) {
          this._player.off('stateChange', onIdle);
          resolve();
        }
      };
      this._player.on('stateChange', onIdle);
    });
  }

  get isPlaying() {
    return this._player.state.status !== AudioPlayerStatus.Idle;
  }

  /** Recursively subscribe to Operator's audio stream, re-subscribe on end. */
  _startListening() {
    if (!this._connection) return;
    this._listening = true;
    this._subscribeOnce();
  }

  _subscribeOnce() {
    if (!this._listening || !this._connection) return;

    const receiver = this._connection.receiver;

    // Subscribe to Operator only — all other users are dropped at socket level
    const audioStream = receiver.subscribe(config.operatorUserId, {
      end: {
        behavior:  EndBehaviorType.AfterSilence,
        duration:  config.vad?.silenceDurationMs ?? 800,
      },
    });

    // Decode Opus → PCM16 mono 16kHz
    const decoder = new prism.opus.Decoder(OPUS_DECODE_OPTS);
    const pcmChunks = [];

    decoder.on('data', (chunk) => pcmChunks.push(chunk));

    decoder.on('end', () => {
      // Re-subscribe immediately so we're always listening
      setImmediate(() => this._subscribeOnce());

      const pcmBuffer = Buffer.concat(pcmChunks);
      if (pcmBuffer.length < MIN_PCM_BYTES) return; // too short to process

      // Fire and forget — pipeline handles the rest
      this._onUtterance(pcmBuffer).catch((err) =>
        console.error('[VC] onUtterance error:', err.message)
      );
    });

    decoder.on('error', (err) => {
      console.error('[VC] Decoder error:', err.message);
      setImmediate(() => this._subscribeOnce());
    });

    audioStream.pipe(decoder);
  }

  /** Schedule a voice channel rejoin with guild membership check. */
  _scheduleVoiceRejoin(attempt = 1) {
    const delay = Math.min(5000 * attempt, 60_000); // cap at 60s
    console.log(`[VC] Scheduling voice rejoin in ${delay}ms (attempt ${attempt})...`);
    setTimeout(async () => {
      // Check guild membership before attempting to rejoin
      try {
        await this._client.guilds.fetch(config.guildId);
      } catch (err) {
        console.error(`[VC] Bot is not in target guild — cannot rejoin voice. ${err.message}`);
        // Don't retry — bot needs manual re-invite. guildDelete handler will fire separately.
        return;
      }
      try {
        await this.join();
        console.log('[VC] Voice rejoin successful.');
      } catch (err) {
        console.error('[VC] Voice rejoin failed:', err.message);
        this._scheduleVoiceRejoin(attempt + 1);
      }
    }, delay);
  }

  /** Leave the voice channel and clean up. */
  leave() {
    this._listening = false;
    this._connection?.destroy();
    this._connection = null;
  }
}
