'use strict';
// Odak Studio - fotograf islem hatti regresyon testleri.
// Sharp'in sabit boru hatti sirasini degil, kullanicinin gordugu sirali
// islemleri dogrular. Electron veya FFmpeg calistirmaz.
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { probeImage } = require(path.join(ROOT, 'electron', 'media.js'));
const photos = require(path.join(ROOT, 'electron', 'photos.js'));
const { previewPhoto, exportPhoto } = photos;
const sharp = require('sharp');

const dir = path.join(os.tmpdir(), 'odak-photo-test');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function pixel(pipeline, x, y) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
const isGreen = ([r, g, b]) => r < 80 && g > 180 && b < 80;
const isBlue = ([r, g, b]) => r < 80 && g < 80 && b > 180;
const isYellow = ([r, g, b]) => r > 180 && g > 180 && b < 80;

async function main() {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });

  const src = path.join(dir, 'kaynak.png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
    <rect width="320" height="240" x="0" y="0" fill="#ff0000"/>
    <rect width="320" height="240" x="320" y="0" fill="#00ff00"/>
    <rect width="320" height="240" x="0" y="240" fill="#0000ff"/>
    <rect width="320" height="240" x="320" y="240" fill="#ffff00"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(src);
  const meta = await probeImage(src);
  console.log('probe:', meta.kind, meta.format, meta.width + 'x' + meta.height,
    '| space:', meta.colorSpace, '| depth:', meta.bitDepth);
  assert(meta.width === 640 && meta.height === 480, 'probe dims wrong');
  assert(meta.bitDepth === 8, 'probe bitDepth should be 8');

  // 1) rotate -> crop -> resize (previously worked, must keep working)
  const r1 = path.join(dir, 'r1.png');
  const e1 = await exportPhoto(src, meta, [
    { type: 'rotate', angle: 90 },
    { type: 'crop', left: 10, top: 10, width: 120, height: 80 },
    { type: 'resize', width: 300, height: 200 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, r1);
  assert(e1.width === 300 && e1.height === 200, 'r1 dims wrong');
  assert(isBlue(await pixel(sharp(r1), 5, 5)), 'r1 pixel should be blue');

  // 2) flip -> crop (Sharp would reorder this; sequential must be correct)
  const r2 = path.join(dir, 'r2.png');
  const e2 = await exportPhoto(src, meta, [
    { type: 'flip', axis: 'h' },
    { type: 'crop', left: 0, top: 0, width: 100, height: 100 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, r2);
  assert(e2.width === 100 && e2.height === 100, 'r2 dims wrong');
  assert(isGreen(await pixel(sharp(r2), 20, 20)), 'flip->crop should be green, got ' + await pixel(sharp(r2), 20, 20));

  // 3) crop -> rotate -> crop (two crops with rotation between)
  const r3 = path.join(dir, 'r3.png');
  const e3 = await exportPhoto(src, meta, [
    { type: 'crop', left: 320, top: 0, width: 320, height: 480 },
    { type: 'rotate', angle: 90 },
    { type: 'crop', left: 0, top: 0, width: 240, height: 320 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, r3);
  assert(e3.width === 240 && e3.height === 320, 'r3 dims wrong');
  assert(isYellow(await pixel(sharp(r3), 120, 160)), 'crop->rotate->crop should be yellow, got ' + await pixel(sharp(r3), 120, 160));

  // 4) rotate -> flip -> crop (flip between rotate and crop)
  const r4 = path.join(dir, 'r4.png');
  const e4 = await exportPhoto(src, meta, [
    { type: 'rotate', angle: 90 },
    { type: 'flip', axis: 'h' },
    { type: 'crop', left: 0, top: 0, width: 120, height: 120 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, r4);
  // rotate CW: TL blue, TR red, BL yellow, BR green; then horizontal flip: TL red.
  assert(e4.width === 120 && e4.height === 120, 'r4 dims wrong');
  assert(isRed(await pixel(sharp(r4), 60, 60)), 'rotate->flip->crop should be red, got ' + await pixel(sharp(r4), 60, 60));

  // 5) copy path stays byte-identical
  const copyOut = path.join(dir, 'kopya.png');
  const copy = await exportPhoto(src, meta, [], { format: 'original', quality: 'max', keepMetadata: true }, copyOut);
  assert(copy.copied, 'copy path not used');
  assert((await fsp.readFile(src)).equals(await fsp.readFile(copyOut)), 'copy bytes differ');

  // 6) EXIF survives a staged export when keepMetadata is on
  const exifSrc = path.join(dir, 'exif.jpg');
  await sharp(src).jpeg({ quality: 92 }).withExif({ IFD0: { Copyright: 'Odak Test', Artist: 'Odak' } }).toFile(exifSrc);
  const exifMeta = await probeImage(exifSrc);
  const exifOut = path.join(dir, 'exif-out.jpg');
  await exportPhoto(exifSrc, exifMeta, [{ type: 'rotate', angle: 90 }, { type: 'crop', left: 0, top: 0, width: 200, height: 200 }],
    { format: 'jpeg', quality: 'high', keepMetadata: true }, exifOut);
  const exifOutMeta = await sharp(exifOut).metadata();
  console.log('exif out bytes:', exifOutMeta.exif ? exifOutMeta.exif.length : 0);
  assert(exifOutMeta.exif && exifOutMeta.exif.length > 20, 'EXIF not preserved');

  // 7) EXIF is stripped when keepMetadata is off
  const stripOut = path.join(dir, 'exif-strip.jpg');
  await exportPhoto(exifSrc, exifMeta, [{ type: 'rotate', angle: 90 }, { type: 'crop', left: 0, top: 0, width: 200, height: 200 }],
    { format: 'jpeg', quality: 'high', keepMetadata: false }, stripOut);
  assert(!(await sharp(stripOut).metadata()).exif, 'EXIF should be stripped');

  // 8) 16-bit depth survives the stages
  const raw16 = new Uint16Array(320 * 200 * 3);
  for (let i = 0; i < raw16.length; i += 3) {
    raw16[i] = 60000;
    raw16[i + 1] = 12000;
    raw16[i + 2] = 3000;
  }
  const deep = path.join(dir, 'derin.png');
  await sharp(raw16, { raw: { width: 320, height: 200, channels: 3 } }).toColourspace('rgb16').png().toFile(deep);
  const deepMeta = await probeImage(deep);
  console.log('16-bit probe bitDepth:', deepMeta.bitDepth, deepMeta.width + 'x' + deepMeta.height);
  assert(deepMeta.bitDepth === 16, '16-bit source not detected');
  const deepOut = path.join(dir, 'derin-out.png');
  await exportPhoto(deep, deepMeta, [{ type: 'rotate', angle: 90 }, { type: 'crop', left: 0, top: 0, width: 120, height: 100 }],
    { format: 'png', quality: 'max', keepMetadata: false }, deepOut);
  const deepOutMeta = await sharp(deepOut).metadata();
  console.log('16-bit out depth:', deepOutMeta.depth, 'dims', deepOutMeta.width + 'x' + deepOutMeta.height);
  assert(deepOutMeta.depth === 'ushort', '16-bit depth lost');

  // 9) EXIF orientation is auto-applied to previews
  const rotatedSrc = path.join(dir, 'oryan.jpg');
  await sharp(src).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toFile(rotatedSrc);
  const rotatedMeta = await probeImage(rotatedSrc);
  assert(rotatedMeta.width === 480 && rotatedMeta.height === 640, 'probe orientation swap wrong: ' + rotatedMeta.width + 'x' + rotatedMeta.height);
  const rotPrev = await previewPhoto(rotatedSrc, rotatedMeta, []);
  console.log('oriented preview:', rotPrev.previewWidth + 'x' + rotPrev.previewHeight, 'full', rotPrev.fullWidth + 'x' + rotPrev.fullHeight);
  assert(rotPrev.previewWidth < rotPrev.previewHeight, 'preview should be portrait after auto-orient');
  assert(rotPrev.fullWidth === 480 && rotPrev.fullHeight === 640, 'oriented full dims wrong');

  // 10) out-of-bounds crop rejected
  let rejected = false;
  try {
    await exportPhoto(src, meta, [{ type: 'crop', left: 600, top: 0, width: 200, height: 100 }],
      { format: 'png', quality: 'max' }, path.join(dir, 'gecersiz.png'));
  } catch { rejected = true; }
  assert(rejected, 'out-of-bounds crop was not rejected');

  // 11) auto-orient happens before user ops (stored 640x480, EXIF orientation 6)
  const oOut = path.join(dir, 'oryan-out.png');
  await exportPhoto(rotatedSrc, rotatedMeta, [
    { type: 'flip', axis: 'h' },
    { type: 'crop', left: 0, top: 0, width: 100, height: 100 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, oOut);
  // Displayed after auto-orient: TL blue, TR red, BL yellow, BR green; flip h -> TL red.
  assert(isRed(await pixel(sharp(oOut), 50, 50)), 'auto-orient before ops failed: ' + await pixel(sharp(oOut), 50, 50));

  // 12) resize -> crop must crop the resized image (Sharp would reorder)
  const rOut = path.join(dir, 'resize-crop.png');
  await exportPhoto(src, meta, [
    { type: 'resize', width: 320, height: 240 },
    { type: 'crop', left: 160, top: 0, width: 160, height: 120 },
  ], { format: 'png', quality: 'max', keepMetadata: false }, rOut);
  assert(isGreen(await pixel(sharp(rOut), 80, 60)), 'resize->crop should be green: ' + await pixel(sharp(rOut), 80, 60));

  // 13) Display-P3 profile survives a lossless stage without colour shift
  const p3Src = path.join(dir, 'p3.jpg');
  await sharp({ create: { width: 240, height: 160, channels: 3, background: { r: 51, g: 102, b: 204 } } })
    .jpeg({ quality: 98 }).withIccProfile('p3').toFile(p3Src);
  const p3Meta = await probeImage(p3Src);
  console.log('p3 probe:', p3Meta.colorSpace, 'bitDepth', p3Meta.bitDepth);
  const direct = await pixel(sharp(p3Src).rotate().toColourspace('srgb'), 100, 80);
  const p3Stage = await sharp(p3Src).rotate().withMetadata({ orientation: 1 }).toColourspace('srgb').png().toBuffer();
  const staged = await pixel(sharp(p3Stage).toColourspace('srgb'), 100, 80);
  console.log('p3 direct:', direct.join(','), 'staged:', staged.join(','));
  assert(direct.every((v, i) => Math.abs(v - staged[i]) <= 2), 'P3 round-trip colour shift');

  // 14) unsupported re-encode targets are rejected (HEIC/GIF sources)
  let unsupported = false;
  try {
    await exportPhoto(src, meta, [{ type: 'rotate', angle: 90 }],
      { format: 'gif', quality: 'max', keepMetadata: true }, path.join(dir, 'gecersiz.gif'));
  } catch { unsupported = true; }
  assert(unsupported, 'unsupported re-encode target was not rejected');

  // 15) TIFF cikti: kayipsiz ve 16-bit derinlik korunur
  const tiffOut = path.join(dir, 'derin-out.tif');
  await exportPhoto(deep, deepMeta, [{ type: 'rotate', angle: 90 }],
    { format: 'tiff', quality: 'max', keepMetadata: false }, tiffOut);
  const tiffMeta = await sharp(tiffOut).metadata();
  console.log('TIFF out:', tiffMeta.format, tiffMeta.width + 'x' + tiffMeta.height, 'depth', tiffMeta.depth);
  assert(tiffMeta.format === 'tiff', 'TIFF format wrong');
  assert(tiffMeta.depth === 'ushort', 'TIFF 16-bit depth lost');

  // 16) AVIF cikti
  const avifOut = path.join(dir, 'cikti.avif');
  await exportPhoto(src, meta, [{ type: 'crop', left: 0, top: 0, width: 200, height: 120 }],
    { format: 'avif', quality: 'balanced', keepMetadata: true }, avifOut);
  const avifMeta = await sharp(avifOut).metadata();
  console.log('AVIF out:', avifMeta.format, avifMeta.width + 'x' + avifMeta.height);
  assert(avifMeta.width === 200 && avifMeta.height === 120, 'AVIF dims wrong');
  assert(['heif', 'avif'].includes(avifMeta.format), 'AVIF format unexpected: ' + avifMeta.format);
  const avifProbe = await probeImage(avifOut);
  console.log('AVIF probe format:', avifProbe.format);
  assert(avifProbe.format === 'avif', 'AVIF must probe as avif, got ' + avifProbe.format);
  const avifEdit = path.join(dir, 'avif-edit.avif');
  await exportPhoto(avifOut, avifProbe, [{ type: 'rotate', angle: 90 }],
    { format: 'original', quality: 'max', keepMetadata: true }, avifEdit);
  const avifEditMeta = await sharp(avifEdit).metadata();
  console.log('AVIF edit:', avifEditMeta.width + 'x' + avifEditMeta.height);
  assert(avifEditMeta.width === 120 && avifEditMeta.height === 200, 'AVIF edit dims wrong');

  // 17) 16-bit kaynak -> 8-bit JPEG/WebP'e iner, AVIF hata vermez
  const deepJpeg = path.join(dir, 'derin.jpg');
  await exportPhoto(deep, deepMeta, [{ type: 'rotate', angle: 90 }],
    { format: 'jpeg', quality: 'max', keepMetadata: true }, deepJpeg);
  const deepJpegMeta = await sharp(deepJpeg).metadata();
  console.log('deep JPEG:', deepJpegMeta.format, deepJpegMeta.width + 'x' + deepJpegMeta.height, 'depth', deepJpegMeta.depth);
  assert(deepJpegMeta.format === 'jpeg', 'deep JPEG format wrong');
  assert(deepJpegMeta.depth === 'uchar', 'JPEG should be 8-bit');

  const deepWebp = path.join(dir, 'derin.webp');
  await exportPhoto(deep, deepMeta, [{ type: 'flip', axis: 'h' }],
    { format: 'webp', quality: 'max', keepMetadata: false }, deepWebp);
  const deepWebpMeta = await sharp(deepWebp).metadata();
  console.log('deep WebP:', deepWebpMeta.format, deepWebpMeta.width + 'x' + deepWebpMeta.height, 'depth', deepWebpMeta.depth);
  assert(deepWebpMeta.format === 'webp', 'deep WebP format wrong');

  const deepAvif = path.join(dir, 'derin.avif');
  await exportPhoto(deep, deepMeta, [{ type: 'resize', width: 100, height: 100 }],
    { format: 'avif', quality: 'balanced', keepMetadata: true }, deepAvif);
  const deepAvifMeta = await sharp(deepAvif).metadata();
  console.log('deep AVIF:', deepAvifMeta.format, deepAvifMeta.width + 'x' + deepAvifMeta.height, 'depth', deepAvifMeta.depth);
  assert(deepAvifMeta.width === 100 && deepAvifMeta.height === 100, 'deep AVIF dims wrong');
  assert(deepAvifMeta.depth === 'ushort', 'deep AVIF should be 10-bit (ushort), got ' + deepAvifMeta.depth);

  // 18) Büyük görselde önizleme küçültülmüş ölçekte hazırlanır ama
  // işlem sırası ve kırpma konumu tam çözünürlükteki çıktıyla aynıdır.
  const bigSrc = path.join(dir, 'buyuk.png');
  const bigSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="4400" height="3300">
    <rect width="2200" height="1650" x="0" y="0" fill="#ff0000"/>
    <rect width="2200" height="1650" x="2200" y="0" fill="#00ff00"/>
    <rect width="2200" height="1650" x="0" y="1650" fill="#0000ff"/>
    <rect width="2200" height="1650" x="2200" y="1650" fill="#ffff00"/>
  </svg>`;
  await sharp(Buffer.from(bigSvg)).png().toFile(bigSrc);
  const bigMeta = await probeImage(bigSrc);
  const bigOps = [
    { type: 'flip', axis: 'h' },
    { type: 'crop', left: 0, top: 0, width: 3000, height: 2000 },
  ];
  const scale = photos.previewScale(bigMeta, bigOps);
  assert(scale > 0.7 && scale < 0.75, 'preview scale should follow the 3000px crop: ' + scale);
  const bigPrev = await previewPhoto(bigSrc, bigMeta, bigOps);
  console.log('scaled preview:', bigPrev.previewWidth + 'x' + bigPrev.previewHeight, 'full', bigPrev.fullWidth + 'x' + bigPrev.fullHeight);
  assert(bigPrev.fullWidth === 3000 && bigPrev.fullHeight === 2000, 'scaled preview full dims wrong');
  assert(bigPrev.previewWidth === 2200 && Math.abs(bigPrev.previewHeight - 1467) <= 1, 'scaled preview dims wrong');
  const prevImg = sharp(Buffer.from(bigPrev.dataUrl.split(',')[1], 'base64'));
  // Yatay çevirme sonrası: sol üst yeşil, sağ üst kırmızı, sol alt sarı.
  assert(isGreen(await pixel(prevImg.clone(), 100, 100)), 'scaled preview TL should be green');
  assert(isRed(await pixel(prevImg.clone(), 1900, 100)), 'scaled preview TR should be red');
  assert(isYellow(await pixel(prevImg.clone(), 100, 1400)), 'scaled preview BL should be yellow');
  // Küçük bir alan kırpılırsa önizleme netlik için tam çözünürlükte yapılır.
  assert(photos.previewScale(bigMeta, [{ type: 'crop', left: 0, top: 0, width: 800, height: 600 }]) === 1,
    'small crop should keep full-resolution preview');
  // Büyütme varsa ara görüntünün ayrıntısı korunur (ölçek kaynağa göre).
  assert(photos.previewScale(bigMeta, [{ type: 'resize', width: 8800, height: 6600 }]) === 0.5,
    'upscale preview scale should follow the smaller stage');

  console.log('PHOTO-TEST-OK');
}

main()
  .catch((error) => { console.error('PHOTO-TEST-FAIL', error); process.exit(1); })
  .finally(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
