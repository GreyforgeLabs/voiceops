/**
 * asr.mjs — Whisper API ASR wrapper.
 *
 * Accepts a PCM Buffer (16kHz 16-bit signed LE mono from Discord), wraps it
 * in a WAV header, and sends it to OpenAI's whisper-1 endpoint.
 *
 * Returns the transcript string, or null if the audio is too quiet / empty.
 *
 * Built by Greyforge Labs — https://greyforge.tech
 * https://github.com/GreyforgeLabs/voiceops
 */

import { config } from './config.mjs';

const ASR_URL     = 'https://api.openai.com/v1/audio/transcriptions';
const SAMPLE_RATE = 16000;
const CHANNELS    = 1;
const BIT_DEPTH   = 16;

/**
 * Compute RMS energy of a 16-bit signed LE PCM buffer.
 * Returns a value 0..1 (1 = full-scale).
 */
function rmsEnergy(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcmBuffer.readInt16LE(i * 2) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

/**
 * Wrap raw PCM bytes in a minimal WAV header.
 */
function buildWav(pcmData) {
  const byteRate   = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);
  const dataSize   = pcmData.length;
  const header     = Buffer.alloc(44);

  header.write('RIFF',  0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE',  8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16,          16);
  header.writeUInt16LE(1,           20);
  header.writeUInt16LE(CHANNELS,    22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate,    28);
  header.writeUInt16LE(blockAlign,  32);
  header.writeUInt16LE(BIT_DEPTH,   34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize,    40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Transcribe a PCM buffer using OpenAI Whisper.
 *
 * @param {Buffer} pcmBuffer  16kHz 16-bit signed LE mono PCM
 * @returns {Promise<string|null>}  Transcript text, or null if too quiet / rejected
 */
export async function transcribe(pcmBuffer) {
  if (!config.openaiApiKey) {
    console.error('[ASR] Missing transcription key. Set OPENAI_API_KEY or asr.openaiApiKey.');
    return null;
  }

  const rmsThreshold = config.vad.rmsThreshold;
  const minDurationMs = config.vad.minUtteranceDurationMs;

  // Duration check
  const durationMs = (pcmBuffer.length / 2 / SAMPLE_RATE) * 1000;
  if (durationMs < minDurationMs) {
    console.log(`[ASR] Skipping short clip (${durationMs.toFixed(0)}ms < ${minDurationMs}ms)`);
    return null;
  }

  // RMS energy gate — discard near-silence
  const rms = rmsEnergy(pcmBuffer);
  if (rms < rmsThreshold) {
    console.log(`[ASR] Skipping low-energy audio (RMS ${rms.toFixed(4)} < ${rmsThreshold})`);
    return null;
  }

  const wavBuffer = buildWav(pcmBuffer);
  const form = new FormData();

  // Node 24 FormData accepts a Blob
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  form.append('file', blob, 'audio.wav');
  form.append('model',    config.asr.model);
  if (config.asr.language) form.append('language', config.asr.language);
  form.append('response_format', 'text');

  const timeoutMs = config.asr.timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ASR_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[ASR] Whisper API request timed out after ${timeoutMs}ms`);
      return null;
    }
    console.error(`[ASR] Whisper API request failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[ASR] Whisper API error ${res.status}: ${body}`);
    return null;
  }

  const transcript = (await res.text()).trim();
  if (config.privacy.logTranscripts) {
    console.log(`[ASR] Transcript (RMS=${rms.toFixed(3)}, ${durationMs.toFixed(0)}ms): "${transcript}"`);
  } else {
    console.log(`[ASR] Transcript accepted (chars=${transcript.length}, RMS=${rms.toFixed(3)}, ${durationMs.toFixed(0)}ms)`);
  }
  return transcript || null;
}
