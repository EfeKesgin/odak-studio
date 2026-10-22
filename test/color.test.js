'use strict';
// Odak Studio - renk profili / renk uzayi disa aktarma testleri.
// P3 ve CMYK kaynaklarin gorunumu metadata acik/kapali korunmali.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { probeImage } = require(path.join(ROOT, 'electron', 'media.js'));
const { exportPhoto } = require(path.join(ROOT, 'electron', 'photos.js'));
const sharp = require('sharp');

const dir = path.join(os.tmpdir(), 'odak-color-test');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function pixel(input) {
  const { data, info } = await sharp(input).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const i = (20 * info.width + 20) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const close = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function main() {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  // Display P3 JPEG kaynagi
  const p3 = path.join(dir, 'p3.jpg');
  await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 51, g: 102, b: 204 } } })
    .jpeg({ quality: 98 }).withIccProfile('p3').toFile(p3);
  const p3Meta = await probeImage(p3);
  assert(p3Meta.colorSpace === 'srgb', 'p3 colorSpace probe: ' + p3Meta.colorSpace);
  const p3Original = await pixel(p3);
  console.log('P3 source sRGB pixel:', p3Original.join(','));

  // 1) P3 -> JPEG, metadata acik: etiketli profil ile piksel ayni gorunmeli
  const outMeta = path.join(dir, 'p3-meta.jpg');
  await exportPhoto(p3, p3Meta, [], { format: 'jpeg', quality: 'max', keepMetadata: true }, outMeta);
  const m = await sharp(outMeta).metadata();
  const metaPixel = await pixel(outMeta);
  console.log('P3 -> JPEG (meta) pixel:', metaPixel.join(','), 'icc:', m.icc ? m.icc.length : 0);
  assert(close(metaPixel, p3Original), 'P3 metadata export colour shift: ' + metaPixel.join(','));

  // 2) P3 -> PNG, metadata acik
  const outPng = path.join(dir, 'p3.png');
  await exportPhoto(p3, p3Meta, [], { format: 'png', quality: 'max', keepMetadata: true }, outPng);
  const pngMeta = await sharp(outPng).metadata();
  const pngPixel = await pixel(outPng);
  console.log('P3 -> PNG (meta) pixel:', pngPixel.join(','), 'icc:', pngMeta.icc ? pngMeta.icc.length : 0);
  assert(close(pngPixel, p3Original), 'P3 PNG export colour shift: ' + pngPixel.join(','));
  assert(pngMeta.icc && pngMeta.icc.length > 20, 'P3 PNG ICC missing');

  // 3) P3 -> JPEG, metadata kapali: profilsiz sRGB, ayni gorunum
  const outStrip = path.join(dir, 'p3-strip.jpg');
  await exportPhoto(p3, p3Meta, [], { format: 'jpeg', quality: 'max', keepMetadata: false }, outStrip);
  const s = await sharp(outStrip).metadata();
  const stripPixel = await pixel(outStrip);
  console.log('P3 -> JPEG (strip) pixel:', stripPixel.join(','), 'icc:', s.icc ? s.icc.length : 0);
  assert(!s.icc, 'P3 strip still has ICC');
  assert(close(stripPixel, p3Original), 'P3 strip colour shift: ' + stripPixel.join(','));

  // 4) CMYK JPEG -> PNG (metadata acik), gorunum korunmali
  const cmyk = path.join(dir, 'cmyk.jpg');
  await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .toColourspace('cmyk').jpeg({ quality: 98 }).toFile(cmyk);
  const cmykMeta = await probeImage(cmyk);
  const cmykOriginal = await pixel(cmyk);
  console.log('CMYK probe:', cmykMeta.colorSpace, 'pixel:', cmykOriginal.join(','));
  const cmykOut = path.join(dir, 'cmyk-out.png');
  await exportPhoto(cmyk, cmykMeta, [], { format: 'png', quality: 'max', keepMetadata: true }, cmykOut);
  const cmykOutPixel = await pixel(cmykOut);
  const cmykOutMeta = await sharp(cmykOut).metadata();
  console.log('CMYK -> PNG pixel:', cmykOutPixel.join(','), 'icc:', cmykOutMeta.icc ? cmykOutMeta.icc.length : 0);
  assert(close(cmykOutPixel, cmykOriginal, 4), 'CMYK export colour shift: ' + cmykOutPixel.join(','));

  // 5) CMYK -> JPEG (metadata kapali), gorunum korunmali
  const cmykStrip = path.join(dir, 'cmyk-strip.jpg');
  await exportPhoto(cmyk, cmykMeta, [], { format: 'jpeg', quality: 'max', keepMetadata: false }, cmykStrip);
  const cmykStripPixel = await pixel(cmykStrip);
  console.log('CMYK -> JPEG (strip) pixel:', cmykStripPixel.join(','));
  assert(close(cmykStripPixel, cmykOriginal, 4), 'CMYK strip colour shift: ' + cmykStripPixel.join(','));

  console.log('COLOR-TEST-OK');
}

main()
  .catch((error) => { console.error('COLOR-TEST-FAIL', error); process.exit(1); })
  .finally(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
