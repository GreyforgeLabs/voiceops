/**
 * tts.mjs — Kokoro-js TTS engine (subprocess wrapper).
 *
 * The phonemizer Emscripten WASM module calls process.exit() during its
 * cleanup cycle. To keep the main VoiceOps process alive, synthesis runs
 * in a child process (tts-worker.mjs) which is allowed to exit normally.
 *
 * The worker reads text from stdin and writes a complete WAV file to stdout.
 * Cold-start: first call loads the 82MB ONNX model (~1–2s). Each call spawns
 * a fresh subprocess — the WASM exit is contained and the model reloads per call.
 * Warm-path latency is <300ms for typical responses.
 *
 * Audio output: 24kHz mono 16-bit WAV — ffmpeg in @discordjs/voice converts
 * to Opus for Discord playback.
 *
 * Built by Greyforge Labs — https://greyforge.tech
 * https://github.com/GreyforgeLabs/voiceops
 */

import { spawn } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.mjs';

const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const WORKER_PATH = resolve(__dirname, 'tts-worker.mjs');

// Per-call timeout: ~5s for cold start + synthesis; 3s warm
const TTS_TIMEOUT_MS = 30_000;
const ALLOWED_TTS_EXIT_CODES = new Set([0, 7]);

export function isWaveBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 44 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

/**
 * Synthesize text into a WAV buffer.
 *
 * Spawns tts-worker.mjs as a subprocess. The worker exits when done
 * (including the WASM cleanup call). WAV bytes are returned via stdout.
 *
 * @param {string} text
 * @returns {Promise<Buffer|null>}  WAV buffer (24kHz mono 16-bit), or null on failure
 */
export async function synthesize(text) {
  const voice = config.tts?.voice ?? 'af_bella';
  const speed = String(config.tts?.speed ?? 1.0);

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER_PATH, voice, speed], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const wavChunks = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error(`TTS worker timed out after ${TTS_TIMEOUT_MS}ms`));
    }, TTS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => wavChunks.push(chunk));
    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[TTS]`, msg);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`TTS worker spawn failed: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;

      const wav = Buffer.concat(wavChunks);
      if (signal || !ALLOWED_TTS_EXIT_CODES.has(code)) {
        reject(new Error(`TTS worker exited ${signal ?? code}`));
        return;
      }
      if (!isWaveBuffer(wav)) {
        reject(new Error('TTS worker did not return a valid WAV buffer'));
        return;
      }
      // Success — worker may exit with code 7 due to Emscripten WASM cleanup
      resolve(wav);
    });

    // Write text to worker stdin
    proc.stdin.write(text, 'utf8');
    proc.stdin.end();
  });
}
