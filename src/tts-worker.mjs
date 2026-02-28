/**
 * tts-worker.mjs — Kokoro TTS synthesis worker (runs as a subprocess).
 *
 * The phonemizer Emscripten WASM module calls process.exit() during its
 * cleanup cycle. Running synthesis in a subprocess lets the WASM exit
 * cleanly without killing the main VoiceOps process.
 *
 * Protocol:
 *   stdin:  text to synthesize (UTF-8, read until EOF)
 *   stdout: WAV file bytes (24kHz mono 16-bit)
 *   stderr: progress/error messages
 *   exit 0: success (WAV bytes written to stdout)
 *   exit 1: synthesis error
 *   exit 7: expected — Emscripten WASM cleanup; tts.mjs treats this as success
 *
 * Usage: node tts-worker.mjs <voice> <speed>
 *        voice defaults to 'af_bella', speed to 1.0
 */

import { KokoroTTS } from 'kokoro-js';

const MODEL_ID   = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SAMPLE_RATE = 24000;
const voice = process.argv[2] ?? 'af_bella';
const speed = parseFloat(process.argv[3] ?? '1.0');

// Read all text from stdin
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const text = Buffer.concat(chunks).toString('utf8').trim();

if (!text) {
  process.stderr.write('[TTS-worker] Empty input\n');
  process.exit(1);
}

let engine;
try {
  engine = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32' });
} catch (e) {
  process.stderr.write(`[TTS-worker] Model load failed: ${e.message}\n`);
  process.exit(1);
}

let rawAudio;
try {
  rawAudio = await engine.generate(text, { voice, speed });
} catch (e) {
  process.stderr.write(`[TTS-worker] Synthesis failed: ${e.message}\n`);
  process.exit(1);
}

// RawAudio from @huggingface/transformers uses .audio (Float32Array), not .data
const float32 = rawAudio?.audio ?? rawAudio?.data;
if (!float32?.length) {
  process.stderr.write('[TTS-worker] Empty audio output\n');
  process.exit(1);
}

// Convert Float32 → Int16 PCM
const pcm16   = new Int16Array(float32.length);
for (let i = 0; i < float32.length; i++) {
  const c = Math.max(-1.0, Math.min(1.0, float32[i]));
  pcm16[i] = c < 0 ? c * 32768 : c * 32767;
}

const pcmBuf = Buffer.from(pcm16.buffer);

// Build WAV header
const byteRate   = SAMPLE_RATE * 1 * 2;
const header     = Buffer.alloc(44);
header.write('RIFF',  0);  header.writeUInt32LE(36 + pcmBuf.length, 4);
header.write('WAVE',  8);  header.write('fmt ', 12);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1,           20);
header.writeUInt16LE(1,  22); header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(byteRate, 28); header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34); header.write('data', 36);
header.writeUInt32LE(pcmBuf.length, 40);

const wav = Buffer.concat([header, pcmBuf]);
process.stdout.write(wav);
// Worker now exits (WASM cleanup calls process.exit(7) — expected and harmless)
