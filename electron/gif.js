'use strict';

const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { clamp, exists } = require('./util');
const { runFfmpegProcess } = require('./media');

const shared = require('../src/shared.js');

const MAX_ITEMS = shared.GIF_MAX_ITEMS;
const MAX_DURATION = shared.GIF_MAX_DURATION;
const MAX_FRAMES = shared.GIF_MAX_FRAMES;
const FPS_OPTIONS = shared.GIF_FPS_VALUES;
const ratioValue = shared.gifRatioValue;

function even(value, min = 2) {
  const rounded = Math.max(min, Math.round(Number(value) || 0));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function sourceDims(meta) {
  const width = Math.max(1, Math.round(Number(meta?.width) || 0));
  const height = Math.max(1, Math.round(Number(meta?.height) || 0));
  return { width, height };
}

function centeredCrop(width, height, targetRatio) {
  if (!(targetRatio > 0) || width < 2 || height < 2) return null;
  const sourceRatio = width / height;
  let cropWidth = width;
  let cropHeight = height;
  if (sourceRatio > targetRatio) {
    cropWidth = Math.max(2, Math.round(height * targetRatio));
    cropHeight = height;
  } else if (sourceRatio < targetRatio) {
    cropWidth = width;
    cropHeight = Math.max(2, Math.round(width / targetRatio));
  }
  cropWidth = Math.min(width, Math.max(2, cropWidth));
  cropHeight = Math.min(height, Math.max(2, cropHeight));
  const x = Math.min(Math.max(0, width - cropWidth), Math.max(0, Math.round((width - cropWidth) / 2)));
  const y = Math.min(Math.max(0, height - cropHeight), Math.max(0, Math.round((height - cropHeight) / 2)));
  if (cropWidth >= width && cropHeight >= height) return null;
  return { width: cropWidth, height: cropHeight, x, y };
}

function normalizeItem(item, canvasRatio) {
  if (!item || typeof item !== 'object') {
    throw new Error('GIF klibi geçersiz.');
  }
  const meta = item.meta;
  if (!meta || (meta.kind !== 'video' && meta.kind !== 'image')) {
    throw new Error('GIF klibi için medya bilgisi bulunamadı.');
  }
  const path = String(item.path || meta.path || '');
  if (!path) throw new Error('GIF klibi için dosya yolu bulunamadı.');
  const { width: sourceWidth, height: sourceHeight } = sourceDims(meta);
  if (sourceWidth < 2 || sourceHeight < 2) {
    throw new Error(`${meta.name || 'Medya'} boyutu okunamadı.`);
  }

  const explicitCropRatio = ratioValue(item.cropRatio);
  const cropRatio = explicitCropRatio || canvasRatio;
  const crop = centeredCrop(sourceWidth, sourceHeight, cropRatio) || null;

  if (meta.kind === 'video') {
    const duration = Number(meta.duration) || 0;
    if (!(duration > 0)) throw new Error(`${meta.name || 'Video'} süresi okunamadı.`);
    let start = clamp(Number(item.trimStart) || 0, 0, Math.max(0, duration));
    let end = clamp(Number(item.trimEnd) || duration, 0, duration);
    if (end <= start) {
      start = 0;
      end = duration;
    }
    const sourceDuration = Math.max(0.05, end - start);
    const speed = clamp(Number(item.speed) || 1, 0.25, 4);
    return {
      path,
      kind: 'video',
      name: meta.name || path,
      sourceWidth,
      sourceHeight,
      crop,
      start,
      end,
      sourceDuration,
      speed,
      duration: Math.max(0.05, sourceDuration / speed),
      fps: Number(meta.fps) || 0,
      hasAudio: Boolean(meta.hasAudio),
      isHdr: Boolean(meta.isHdr),
      colorTransfer: String(meta.colorTransfer || ''),
    };
  }

  const duration = clamp(Number(item.duration) || 2, 0.1, 30);
  return {
    path,
    kind: 'photo',
    name: meta.name || path,
    sourceWidth,
    sourceHeight,
    crop,
    start: 0,
    end: duration,
    sourceDuration: duration,
    speed: 1,
    duration,
    fps: 0,
    hasAudio: false,
    isHdr: false,
  };
}

function buildGifPlan(items, settings = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('GIF oluşturmak için en az bir video veya fotoğraf ekleyin.');
  }
  if (items.length > MAX_ITEMS) {
    throw new Error(`GIF en fazla ${MAX_ITEMS} klipten oluşturulabilir.`);
  }

  const requestedWidth = Math.round(Number(settings.width) || 480);
  const width = even(clamp(requestedWidth, 160, 960), 2);
  const fps = FPS_OPTIONS.includes(Number(settings.fps)) ? Number(settings.fps) : 12;
  const loopValue = Number(settings.loop);
  const loop = Number.isFinite(loopValue) ? clamp(Math.round(loopValue), 0, 20) : 0;
  const requestedRatio = String(settings.ratio || 'auto');
  const explicitCanvasRatio = ratioValue(requestedRatio);

  // Oran "otomatik" ise ilk klibin kaynak oranı (veya seçilmiş kırpma
  // oranı) tuvali belirler. Böylece ilk klibin etrafında gereksiz siyah
  // alan oluşmaz.
  const first = items[0];
  const firstMeta = first?.meta;
  const firstDims = sourceDims(firstMeta);
  const firstCropRatio = ratioValue(first?.cropRatio);
  const autoRatio = firstCropRatio || (firstDims.width / Math.max(1, firstDims.height));
  const canvasRatio = explicitCanvasRatio || autoRatio || 16 / 9;
  const height = even(clamp(Math.round(width / canvasRatio), 2, 1600), 2);

  const clips = items.map((item) => normalizeItem(item, canvasRatio));
  const duration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const frames = Math.ceil(duration * fps);
  if (duration < 0.05 || frames < 1) {
    throw new Error('GIF süresi çok kısa.');
  }
  if (duration > MAX_DURATION || frames > MAX_FRAMES) {
    throw new Error(
      `GIF çok uzun. En fazla ${MAX_DURATION} saniye veya ${MAX_FRAMES} kare olabilir; kırpma süresini ya da FPS'i azaltın.`,
    );
  }

  // GIF metinleri tüm tuvalde, baştan sona görünür (zamanlama yok).
  const textLayers = shared.cleanTextLayers(settings.textLayers)
    .map((layer) => ({ ...layer, start: 0, end: null }));

  return {
    width,
    height,
    fps,
    loop,
    ratio: requestedRatio,
    canvasRatio,
    duration,
    frames,
    clips,
    textLayers,
  };
}

function hdrToneMapFilter(clip) {
  const transfer = clip.colorTransfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
  return [
    `zscale=pin=bt2020:tin=${transfer}:min=bt2020nc:t=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
  ].join(',');
}

function buildClipFilter(clip, plan) {
  const filters = [];
  // Fotoğrafın ilk karesi filtreyle tekrarlanır; süre sonda trim ile kesilir.
  // "-loop 1" giriş seçeneği yalnızca image2 okuyucusunda vardır; GIF ve AVIF
  // (gif/mov okuyucuları) bu seçenekle hiç açılmaz.
  if (clip.kind === 'photo') {
    filters.push('loop=loop=-1:size=1');
  }
  if (clip.kind === 'video' && Math.abs(clip.speed - 1) > 0.0001) {
    filters.push(`setpts=PTS/${clip.speed.toFixed(4)}`);
  }
  if (clip.kind === 'video' && clip.isHdr) {
    filters.push(hdrToneMapFilter(clip));
  }
  filters.push(`fps=${plan.fps}`);
  if (clip.crop) {
    filters.push(`crop=${clip.crop.width}:${clip.crop.height}:${clip.crop.x}:${clip.crop.y}`);
  }
  filters.push(`scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease:flags=lanczos`);
  filters.push(`pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  filters.push('setsar=1');
  filters.push('format=rgb24');
  filters.push(`trim=duration=${clip.duration.toFixed(3)}`);
  filters.push('setpts=PTS-STARTPTS');
  return filters.join(',');
}

function buildGifFilterGraph(plan) {
  if (!plan || !Array.isArray(plan.clips) || plan.clips.length === 0) {
    throw new Error('GIF planı boş.');
  }
  const parts = [];
  plan.clips.forEach((clip, index) => {
    parts.push(`[${index}:v]${buildClipFilter(clip, plan)}[v${index}]`);
  });

  // Metin, birleştirilmiş tuvale palet hesaplanmadan önce çizilir ki yazı
  // renkleri de 256 renklik palete girsin. text.ass, FFmpeg'in çalıştığı
  // iş klasöründedir (exportGif).
  const text = plan.textLayers && plan.textLayers.length ? 'subtitles=text.ass,' : '';
  if (plan.clips.length === 1) {
    parts.push(`[v0]${text}split[pal][use]`);
  } else {
    const inputs = plan.clips.map((clip, index) => `[v${index}]`).join('');
    parts.push(`${inputs}concat=n=${plan.clips.length}:v=1:a=0[cat]`);
    parts.push(`[cat]${text}split[pal][use]`);
  }

  parts.push('[pal]palettegen=stats_mode=diff:max_colors=256[palette]');
  parts.push('[use][palette]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]');
  return parts.join(';');
}

function buildGifInputArgs(plan) {
  const args = [];
  for (const clip of plan.clips) {
    if (clip.kind === 'video') {
      if (clip.start > 0.001) {
        args.push('-ss', clip.start.toFixed(6));
      }
      args.push('-t', clip.sourceDuration.toFixed(6), '-i', clip.path);
    } else {
      args.push('-t', clip.duration.toFixed(6), '-i', clip.path);
    }
  }
  return args;
}

function buildGifArgs(plan, tempPath) {
  return [
    '-hide_banner',
    '-y',
    '-progress', 'pipe:1',
    '-nostats',
    ...buildGifInputArgs(plan),
    '-filter_complex', buildGifFilterGraph(plan),
    '-map', '[out]',
    '-an', '-sn', '-dn',
    '-loop', String(plan.loop),
    '-f', 'gif',
    '-map_metadata', '-1',
    tempPath,
  ];
}

async function exportGif(engine, plan, tempPath, { onProgress, signal } = {}) {
  const output = path.resolve(tempPath);
  // Metin varsa FFmpeg, text.ass'in bulunduğu geçici klasörde çalışır; bu
  // yüzden kaynak ve çıktı yolları mutlak verilir.
  const absolutePlan = { ...plan, clips: plan.clips.map((clip) => ({ ...clip, path: path.resolve(clip.path) })) };
  let dir = null;
  if (plan.textLayers && plan.textLayers.length) {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-job-'));
    const document = shared.buildAssDocument({ width: plan.width, height: plan.height, layers: plan.textLayers });
    await fsp.writeFile(path.join(dir, 'text.ass'), `﻿${document}`, 'utf8');
  }
  try {
    const args = buildGifArgs(absolutePlan, output);
    await runFfmpegProcess(engine, args, {
      duration: plan.duration,
      onProgress,
      signal,
      cwd: dir || undefined,
    });
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!(await exists(output))) throw new Error('GIF dosyası oluşmadı.');
  const stat = await fsp.stat(output);
  if (stat.size < 64) throw new Error('GIF dosyası boş görünüyor.');
  return {
    size: stat.size,
    width: plan.width,
    height: plan.height,
    duration: plan.duration,
    frames: plan.frames,
  };
}

module.exports = {
  MAX_ITEMS,
  MAX_DURATION,
  MAX_FRAMES,
  FPS_OPTIONS,
  ratioValue,
  centeredCrop,
  hdrToneMapFilter,
  buildGifPlan,
  buildClipFilter,
  buildGifFilterGraph,
  buildGifInputArgs,
  buildGifArgs,
  exportGif,
};
