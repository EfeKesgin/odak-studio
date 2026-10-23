'use strict';

// Gezginde sağ tık → "Odak ile küçült": editör açılmadan, seçilen hazır
// ayarla (Discord / WhatsApp / E-posta) video küçültülür. Çıktı kaynağın
// yanına "<ad>-discord.mp4" gibi yazılır. Kurulum, Windows Gezgini'ne
// "--compress=<ayar>" ile çağıran bir alt menü ekler (installer/open-with.nsh).

const path = require('node:path');
const fs = require('node:fs');

const shared = require('../src/shared.js');

// Sağ tık menüsündeki ayarlar; sıra menüdeki sıradır.
const QUICK_PRESETS = ['discord', 'whatsapp', 'email'];
const SUFFIX = { discord: 'discord', whatsapp: 'whatsapp', email: 'eposta' };

function even(value) {
  return Math.max(2, Math.round(value / 2) * 2);
}

// Komut satırı: "--compress=discord" ve bir veya birden çok video yolu.
function compressRequestFromArgs(argv, isVideoFile) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  const flag = args.find((arg) => /^--compress=/.test(String(arg)));
  if (!flag) return null;
  const preset = String(flag).split('=')[1];
  if (!QUICK_PRESETS.includes(preset)) return null;
  const files = [];
  for (const arg of args) {
    if (!arg || String(arg).startsWith('-')) continue;
    try {
      const file = path.resolve(arg);
      if (isVideoFile(file) && fs.statSync(file).isFile()) files.push(file);
    } catch {
      // Var olmayan yol: atlanır.
    }
  }
  return files.length ? { preset, files } : null;
}

// Hazır ayarın dışa aktarma seçenekleri (editördeki "Hazır ayar" ile aynı
// kural): uzun kenar sınırı yalnızca küçültür, boyutlar çift sayıdır.
function quickCompressOptions(meta, presetId, { encoder = 'cpu' } = {}) {
  const preset = shared.VIDEO_PRESETS.find((item) => item.id === presetId);
  if (!preset || !QUICK_PRESETS.includes(presetId)) throw new Error('Bilinmeyen küçültme ayarı.');
  const settings = preset.settings;
  let resize = null;
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;
  const longEdge = Math.max(width, height);
  if (settings.maxEdge && longEdge > settings.maxEdge) {
    const factor = settings.maxEdge / longEdge;
    resize = { width: even(width * factor), height: even(height * factor) };
  }
  return {
    trimStart: 0,
    trimEnd: Number(meta.duration) || 0,
    segments: [],
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: null,
    resize,
    speed: 1,
    audioMode: meta.hasAudio ? 'original' : 'none',
    mode: settings.quality,
    codec: settings.codec,
    crf: settings.crf || 16,
    preset: settings.preset || 'medium',
    targetMB: settings.targetMB,
    encoder,
    textLayers: [],
    burnSubtitle: -1,
  };
}

function quickCompressBaseName(file, presetId) {
  return `${path.parse(file).name}-${SUFFIX[presetId] || presetId}`;
}

module.exports = {
  QUICK_PRESETS,
  compressRequestFromArgs,
  quickCompressOptions,
  quickCompressBaseName,
};
