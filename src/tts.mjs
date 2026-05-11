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

const ALLOWED_TTS_EXIT_CODES = new Set([0, 7]);
const WORKER_ENV_ALLOWLIST = [
  'HOME',
  'XDG_CACHE_HOME',
  'HF_HOME',
  'TRANSFORMERS_CACHE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'NO_COLOR',
  'FORCE_COLOR',
];
const STDERR_LOG_BYTES = 64 * 1024;

function sanitizedWorkerEnv() {
  const env = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  return env;
}

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
  const normalizedText = String(text ?? '').trim();
  const voice = config.tts.voice;
  const speed = String(config.tts.speed);
  const modelId = config.tts.modelId;
  const timeoutMs = config.tts.timeoutMs;
  const maxInputChars = config.tts.maxInputChars;
  const maxOutputBytes = config.tts.maxOutputBytes;
  const maxInputBytes = maxInputChars * 4;

  if (!normalizedText) return null;
  if (normalizedText.length > maxInputChars) {
    throw new Error(`TTS input exceeded ${maxInputChars} characters`);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER_PATH, voice, speed, modelId, String(maxInputBytes)], {
      env: sanitizedWorkerEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const wavChunks = [];
    let wavBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const fail = (err, kill = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (kill && proc.exitCode == null) proc.kill('SIGKILL');
      reject(err);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      fail(new Error(`TTS worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      if (settled) return;
      wavBytes += chunk.length;
      if (wavBytes > maxOutputBytes) {
        fail(new Error(`TTS worker output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      wavChunks.push(chunk);
    });
    proc.stderr.on('data', (d) => {
      const remaining = STDERR_LOG_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const slice = d.subarray(0, remaining);
      stderrBytes += slice.length;
      const msg = slice.toString().trim();
      if (msg) console.log(`[TTS]`, msg);
    });
    proc.stdin.on('error', () => {
      // The worker may be killed after a timeout or size cap while stdin is still draining.
    });

    proc.on('error', (err) => {
      fail(new Error(`TTS worker spawn failed: ${err.message}`), false);
    });

    proc.on('close', (code, signal) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timeout);

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
    proc.stdin.write(normalizedText, 'utf8');
    proc.stdin.end();
  });
}
