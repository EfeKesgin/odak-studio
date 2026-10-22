'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { clamp } = require('./util');
const shared = require('../src/shared.js');

function loadSharp() {
  try {
    return require('sharp');
  } catch {
    throw new Error('Görsel motoru (sharp) yüklenemedi.');
  }
}

function computePhotoDims(meta, ops = []) {
  let width = Number(meta.width) || 0;
  let height = Number(meta.height) || 0;
  for (const op of ops) {
    if (op.type === 'rotate') {
      const angle = ((Number(op.angle) || 0) % 360 + 360) % 360;
      if (angle === 90 || angle === 270) [width, height] = [height, width];
    } else if (op.type === 'crop') {
      width = Math.max(1, Math.round(Number(op.width) || 0));
      height = Math.max(1, Math.round(Number(op.height) || 0));
    } else if (op.type === 'resize') {
      width = Math.max(1, Math.round(Number(op.width) || 0));
      height = Math.max(1, Math.round(Number(op.height) || 0));
    }
  }
  return { width, height };
}

function validateOps(meta, ops) {
  const sharp = loadSharp();
  let width = Number(meta.width);
  let height = Number(meta.height);
  const cleaned = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    if (op.type === 'rotate') {
      const angle = ((Math.round((Number(op.angle) || 0) / 90) * 90) % 360 + 360) % 360;
      if (![0, 90, 180, 270].includes(angle)) throw new Error('Geçersiz döndürme açısı.');
      if (angle !== 0) cleaned.push({ type: 'rotate', angle });
      if (angle === 90 || angle === 270) [width, height] = [height, width];
    } else if (op.type === 'flip') {
      const axis = op.axis === 'v' ? 'v' : 'h';
      cleaned.push({ type: 'flip', axis });
    } else if (op.type === 'crop') {
      const left = Math.max(0, Math.round(Number(op.left) || 0));
      const top = Math.max(0, Math.round(Number(op.top) || 0));
      const cropWidth = Math.max(1, Math.round(Number(op.width) || 0));
      const cropHeight = Math.max(1, Math.round(Number(op.height) || 0));
      if (left + cropWidth > width || top + cropHeight > height) {
        throw new Error('Kırpma alanı görselin dışına taşıyor.');
      }
      cleaned.push({ type: 'crop', left, top, width: cropWidth, height: cropHeight });
      width = cropWidth;
      height = cropHeight;
    } else if (op.type === 'resize') {
      const nextWidth = Math.round(Number(op.width) || 0);
      const nextHeight = Math.round(Number(op.height) || 0);
      if (nextWidth < 1 || nextHeight < 1 || nextWidth > 32000 || nextHeight > 32000) {
        throw new Error('Geçersiz hedef boyut.');
      }
      cleaned.push({ type: 'resize', width: nextWidth, height: nextHeight });
      width = nextWidth;
      height = nextHeight;
    }
  }
  return { ops: cleaned, width, height, sharp };
}

// Sharp uygular işlemleri çağrı sırasına göre değil, sabit bir iç sıraya göre
// yürütür: çevirmeler her zaman kırpmadan sonra, boru hattı başına tek kırpma
// ve tek yeniden boyutlandırma geçerlidir. Kullanıcının uyguladığı sırayı
// birebir korumak için her işlem kayıpsız bir PNG ara adımına yazılır.
// Böylece aynı anda hem doğru sıra hem de EXIF/ICC taşınması garanti edilir.
const STAGE_PNG = { compressionLevel: 1, adaptiveFiltering: false, palette: false };

function chainOp(pipeline, op) {
  if (op.type === 'rotate') return pipeline.rotate(op.angle);
  if (op.type === 'flip') return op.axis === 'h' ? pipeline.flop() : pipeline.flip();
  if (op.type === 'crop') {
    return pipeline.extract({
      left: op.left,
      top: op.top,
      width: op.width,
      height: op.height,
    });
  }
  if (op.type === 'resize') {
    return pipeline.resize({
      width: op.width,
      height: op.height,
      fit: 'fill',
      kernel: 'lanczos3',
    });
  }
  return pipeline;
}

function isHighDepth(meta) {
  return Number(meta.bitDepth) > 8;
}

// Ara PNG adımları ve son çıktı için renk uzayı + meta veri politikası.
// - 8-bit RGB kaynaklarda EXIF ve ICC profili korunur.
// - CMYK/gri gibi PNG'nin taşıyamayacağı profiller sRGB'ye sabitlenir.
// - 16-bit kaynaklarda PNG/TIFF çıktısı 16-bit olarak tutulur.
function applyOutputProfile(pipeline, meta, keepMetadata, deepOutput) {
  const highDepth = isHighDepth(meta);
  const space = String(meta.colorSpace || '').toLowerCase();
  const rgbSpace = space === 'srgb' || space === 'rgb' || space === 'rgb16';

  if (!keepMetadata) {
    return deepOutput && highDepth
      ? pipeline.toColourspace('rgb16')
      : pipeline.toColourspace('srgb');
  }
  if (!rgbSpace) {
    return pipeline.withMetadata({ orientation: 1 }).withIccProfile('srgb');
  }
  if (highDepth && !deepOutput) {
    return pipeline.withMetadata({ orientation: 1 }).toColourspace('srgb');
  }
  if (highDepth) {
    return pipeline.withMetadata({ orientation: 1 }).toColourspace('rgb16');
  }
  return pipeline.withMetadata({ orientation: 1 });
}

async function encodeStage(pipeline, meta, keepMetadata) {
  const staged = applyOutputProfile(pipeline, meta, keepMetadata, true);
  const { data } = await staged.png(STAGE_PNG).toBuffer({ resolveWithObject: true });
  return data;
}

async function renderOps(sharp, file, meta, ops, keepMetadata, baseSize = null) {
  let source = sharp(file, { failOn: 'none', animated: false }).rotate();
  if (baseSize) {
    source = source.resize({
      width: baseSize.width,
      height: baseSize.height,
      fit: 'fill',
      kernel: 'lanczos3',
    });
  }
  let buffer = await encodeStage(source, meta, keepMetadata);
  for (const op of ops) {
    buffer = await encodeStage(chainOp(sharp(buffer, { failOn: 'none' }), op), meta, keepMetadata);
  }
  return buffer;
}

function sourcePipeline(sharp, file, buffer) {
  return buffer
    ? sharp(buffer, { failOn: 'none' })
    : sharp(file, { failOn: 'none', animated: false }).rotate();
}

const PREVIEW_MAX_EDGE = 2200;

// Önizleme, işlem zincirini tam çözünürlük yerine tek bir ölçek oranında
// yürütür: kaynak bir kez küçültülür, tüm kırpma/boyut koordinatları aynı
// oranla çarpılır. Oran, zincirdeki en küçük ara görüntü bile önizlemede
// gerçek çıktıdan daha az ayrıntı göstermeyecek şekilde seçilir; küçük bir
// alan kırpılırsa oran 1 olur ve önizleme tam çözünürlükte hazırlanır.
function previewScale(meta, ops) {
  let width = Number(meta.width) || 1;
  let height = Number(meta.height) || 1;
  let smallestEdge = Math.max(width, height);
  for (const op of ops) {
    if (op.type === 'rotate' && (op.angle === 90 || op.angle === 270)) {
      [width, height] = [height, width];
    } else if (op.type === 'crop' || op.type === 'resize') {
      width = op.width;
      height = op.height;
    }
    smallestEdge = Math.min(smallestEdge, Math.max(width, height));
  }
  return Math.min(1, PREVIEW_MAX_EDGE / Math.max(1, smallestEdge));
}

function scaleOpsForPreview(meta, ops, scale) {
  let width = Math.max(1, Math.round(Number(meta.width) * scale));
  let height = Math.max(1, Math.round(Number(meta.height) * scale));
  const baseSize = { width, height };
  const scaled = [];
  for (const op of ops) {
    if (op.type === 'rotate') {
      if (op.angle === 90 || op.angle === 270) [width, height] = [height, width];
      scaled.push(op);
    } else if (op.type === 'flip') {
      scaled.push(op);
    } else if (op.type === 'crop') {
      const left = clamp(Math.round(op.left * scale), 0, width - 1);
      const top = clamp(Math.round(op.top * scale), 0, height - 1);
      const cropWidth = clamp(Math.round(op.width * scale), 1, width - left);
      const cropHeight = clamp(Math.round(op.height * scale), 1, height - top);
      scaled.push({ type: 'crop', left, top, width: cropWidth, height: cropHeight });
      width = cropWidth;
      height = cropHeight;
    } else if (op.type === 'resize') {
      width = Math.max(1, Math.round(op.width * scale));
      height = Math.max(1, Math.round(op.height * scale));
      scaled.push({ type: 'resize', width, height });
    }
  }
  return { ops: scaled, baseSize };
}

async function previewPhotoInner(file, meta, ops) {
  const { ops: cleaned, width, height, sharp } = validateOps(meta, ops);
  let staged = null;
  if (cleaned.length) {
    const scale = previewScale(meta, cleaned);
    const { ops: previewOps, baseSize } = scaleOpsForPreview(meta, cleaned, scale);
    staged = await renderOps(sharp, file, meta, previewOps, false, scale < 1 ? baseSize : null);
  }
  const { data, info } = await sourcePipeline(sharp, file, staged)
    .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90, alphaQuality: 100, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  return {
    dataUrl: `data:image/webp;base64,${data.toString('base64')}`,
    previewWidth: info.width,
    previewHeight: info.height,
    fullWidth: width,
    fullHeight: height,
    hasAlpha: Boolean(meta.hasAlpha),
    ops: cleaned,
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LINE_HEIGHT = 1.2;

function svgDocument(width, height, body, defs = '') {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${defs}${body}</svg>`);
}

function svgTextAttributes(layer, fontPx) {
  return [
    `font-family="${escapeXml(layer.font)}"`,
    `font-size="${fontPx.toFixed(2)}"`,
    `font-weight="${layer.bold ? 700 : 400}"`,
    `font-style="${layer.italic ? 'italic' : 'normal'}"`,
    'text-anchor="middle"',
    'dominant-baseline="central"',
    'xml:space="preserve"',
  ].join(' ');
}

// Metin katmanlarını son görüntünün üzerine çizilecek SVG katmanlarına
// çevirir (arayüzdeki önizleme ve video/GIF'teki libass ile aynı ölçüler).
// Kutu stilinde her satırın genişliği ayrı ölçülür ki kutu metni sarsın.
async function textComposites(sharp, layers, width, height) {
  const composites = [];
  for (const layer of shared.cleanTextLayers(layers)) {
    const metrics = shared.textLayerMetrics(layer, height);
    const { fontPx } = metrics;
    const lines = layer.text.split('\n');
    const lineHeight = fontPx * LINE_HEIGHT;
    const centerX = layer.x * width;
    const firstY = layer.y * height - ((lines.length - 1) * lineHeight) / 2;
    const attributes = svgTextAttributes(layer, fontPx);
    const parts = [];
    let defs = '';
    let paint = `fill="${layer.color}"`;
    if (layer.style === 'outline') {
      paint += ` stroke="#000" stroke-width="${(metrics.outlinePx * 2).toFixed(2)}" stroke-linejoin="round" paint-order="stroke"`;
    } else if (layer.style === 'shadow') {
      defs = `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="${metrics.shadowPx.toFixed(2)}" dy="${metrics.shadowPx.toFixed(2)}" stdDeviation="0" flood-color="#000" flood-opacity="0.55"/></filter></defs>`;
      paint += ' filter="url(#s)"';
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const y = firstY + index * lineHeight;
      if (layer.style === 'box') {
        // Satırın mürekkep genişliği, saydam bir tuvalde çizilip kırpılarak ölçülür.
        const probe = svgDocument(width, height, `<text x="${centerX.toFixed(2)}" y="${y.toFixed(2)}" ${attributes} fill="#fff">${escapeXml(line)}</text>`);
        let inkWidth = 0;
        let inkLeft = centerX;
        try {
          const { info } = await sharp(probe).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
          inkWidth = info.width;
          inkLeft = -(info.trimOffsetLeft || 0);
        } catch {
          continue;
        }
        const pad = metrics.boxPadPx;
        const boxHeight = fontPx * 1.15 + pad * 0.8;
        parts.push(`<rect x="${(inkLeft - pad).toFixed(2)}" y="${(y - boxHeight / 2).toFixed(2)}" width="${(inkWidth + pad * 2).toFixed(2)}" height="${boxHeight.toFixed(2)}" fill="#000" fill-opacity="${metrics.boxAlpha}"/>`);
      }
      parts.push(`<text x="${centerX.toFixed(2)}" y="${y.toFixed(2)}" ${attributes} ${paint}>${escapeXml(line)}</text>`);
    }
    if (parts.length) composites.push({ input: svgDocument(width, height, parts.join(''), defs) });
  }
  return composites;
}

function formatToExtension(format) {
  if (format === 'jpeg' || format === 'jpg') return '.jpg';
  if (format === 'png') return '.png';
  if (format === 'webp') return '.webp';
  if (format === 'avif') return '.avif';
  if (format === 'tiff' || format === 'tif') return '.tif';
  return `.${format || 'png'}`;
}

function normalizeFormat(meta) {
  const format = String(meta.format || meta.ext || '').toLowerCase();
  if (format === 'jpg') return 'jpeg';
  return format;
}

function qualityValue(preset) {
  if (preset === 'balanced') return 88;
  if (preset === 'high') return 95;
  return 100;
}

async function exportPhotoInner(file, meta, ops, options, outputPath) {
  const { ops: cleaned, width, height, sharp } = validateOps(meta, ops);
  const requested = options.format || 'original';
  const targetFormat = requested === 'original' ? normalizeFormat(meta) : requested;
  const keepMetadata = options.keepMetadata !== false;
  const textLayers = shared.cleanTextLayers(options.textLayers);

  if (requested === 'original' && cleaned.length === 0 && keepMetadata && !textLayers.length) {
    await fsp.copyFile(file, outputPath);
    const stat = await fsp.stat(outputPath);
    return {
      path: outputPath,
      size: stat.size,
      width: meta.width,
      height: meta.height,
      format: targetFormat,
      copied: true,
    };
  }

  if (!['jpeg', 'png', 'webp', 'avif', 'tiff'].includes(targetFormat)) {
    throw new Error('Bu format doğrudan düzenlenemiyor. Çıktı formatı olarak JPEG, PNG, WebP, AVIF veya TIFF seçin.');
  }

  const staged = cleaned.length ? await renderOps(sharp, file, meta, cleaned, keepMetadata) : null;
  let pipeline = sourcePipeline(sharp, file, staged);
  if (textLayers.length) {
    // Metin, tüm düzenlemelerden sonra son boyuttaki görüntüye çizilir.
    pipeline = pipeline.composite(await textComposites(sharp, textLayers, width, height));
  }
  const quality = qualityValue(options.quality);

  if (targetFormat === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({
      quality,
      chromaSubsampling: quality >= 95 ? '4:4:4' : '4:2:0',
      progressive: true,
      mozjpeg: false,
    });
  } else if (targetFormat === 'png') {
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: false,
    });
  } else if (targetFormat === 'webp') {
    pipeline = pipeline.webp({
      quality: options.quality === 'max' ? 100 : quality,
      alphaQuality: 100,
      lossless: options.quality === 'max',
      effort: 5,
      smartSubsample: true,
    });
  } else if (targetFormat === 'avif') {
    const avifOptions = {
      quality: Math.max(80, quality),
      effort: 5,
    };
    // AVIF 8/10/12 bit destekler; 16-bit kaynaktan 8-bit'e düşmemesi için
    // yüksek derinlikte 10-bit çıktı iste.
    if (meta.bitDepth > 8) avifOptions.bitdepth = 10;
    pipeline = pipeline.avif(avifOptions);
  } else if (targetFormat === 'tiff') {
    pipeline = pipeline.tiff({ compression: 'lzw', predictor: 'horizontal' });
  }

  const deepOutput = targetFormat === 'png' || targetFormat === 'tiff' || targetFormat === 'avif';
  pipeline = applyOutputProfile(pipeline, meta, keepMetadata, deepOutput);

  const info = await pipeline.toFile(outputPath);
  const stat = await fsp.stat(outputPath);
  return {
    path: outputPath,
    size: stat.size,
    width: info.width,
    height: info.height,
    format: info.format || targetFormat,
    copied: false,
  };
}

// Sharp/libheif, HEVC kod çözücü olmadan HEIC/HEIF'i açamıyor. libheif'in
// İngilizce hatasını kullanıcıya anlaşılır biçimde aktar.
function friendlyImageError(error) {
  const message = String((error && error.message) || '');
  if (/HEVC|libde265|has not been built in|heif:/i.test(message)) {
    return new Error('HEIC/HEIF bu sistemde açılamıyor: HEVC kod çözücü bulunmuyor. JPEG, PNG, WebP, AVIF veya TIFF kullanın.');
  }
  return error;
}

async function previewPhoto(file, meta, ops) {
  try {
    return await previewPhotoInner(file, meta, ops);
  } catch (error) {
    throw friendlyImageError(error);
  }
}

async function exportPhoto(file, meta, ops, options, outputPath) {
  try {
    return await exportPhotoInner(file, meta, ops, options, outputPath);
  } catch (error) {
    throw friendlyImageError(error);
  }
}

module.exports = {
  computePhotoDims,
  validateOps,
  previewScale,
  scaleOpsForPreview,
  textComposites,
  previewPhoto,
  exportPhoto,
  formatToExtension,
  normalizeFormat,
};
