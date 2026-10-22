'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

const { sanitizeBaseName } = require('../src/shared.js');

function normalizeExt(ext) {
  if (!ext) return '';
  return ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}

async function uniquePath(dir, baseName, ext) {
  const safeBase = sanitizeBaseName(baseName);
  const safeExt = normalizeExt(ext);
  let candidate = path.join(dir, `${safeBase}${safeExt}`);
  let index = 1;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${safeBase} (${index})${safeExt}`);
    index += 1;
    if (index > 9999) throw new Error('Uygun bir dosya adı bulunamadı.');
  }
  return candidate;
}

function parseRate(value) {
  if (!value || typeof value !== 'string') return 0;
  const [rawNum, rawDen] = value.split('/');
  const num = Number(rawNum);
  const den = Number(rawDen);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function ffmpegError(stderr, fallback) {
  const text = String(stderr || '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-6).join('\n');
  if (/No space left on device/i.test(text)) {
    return new Error('Diskte yeterli alan kalmadı. Farklı bir klasör seçin.');
  }
  if (/Permission denied/i.test(text)) {
    return new Error('Dosya yazılamadı. Klasör izinlerini kontrol edin veya başka bir klasör seçin.');
  }
  if (/Invalid data found|moov atom not found|could not find codec parameters/i.test(text)) {
    return new Error('Dosya okunamadı. Dosya bozuk olabilir ya da desteklenmeyen bir codec içeriyor.');
  }
  if (/Unknown encoder|Encoder .* not found/i.test(text)) {
    return new Error('Seçilen codec bu FFmpeg kurulumunda bulunamadı.');
  }
  const err = new Error(fallback || 'İşlem tamamlanamadı.');
  err.details = tail;
  return err;
}

module.exports = {
  execFileAsync,
  exists,
  ensureDir,
  sanitizeBaseName,
  normalizeExt,
  uniquePath,
  parseRate,
  clamp,
  formatDuration,
  ffmpegError,
};
