'use strict';

// Toplu işlem ayarlarını dosya bazlı dışa aktarma seçeneklerine çeviren saf
// yardımcılar. Electron ve tarayıcı tarafında aynı dosya kullanılır; DOM'a
// dokunmadığı için Node testlerinde doğrudan çalıştırılabilir.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./shared.js') : root.OdakShared);
  if (isNode) module.exports = api;
  if (root) root.OdakBatchPlan = api;
}(typeof window !== 'undefined' ? window : null, function (shared) {
  const { GIF_MAX_DURATION, GIF_MAX_FRAMES, GIF_FPS_VALUES } = shared;
  // "1" yalnızca eski bir takma ad; ayar listesinde gösterilmez.
  const GIF_RATIO_VALUES = ['auto', ...Object.keys(shared.GIF_RATIOS).filter((key) => key.includes(':'))];
  const PHOTO_FORMATS = ['original', 'jpeg', 'png', 'webp', 'avif', 'tiff'];
  const VIDEO_CODECS = ['h264', 'h265', 'vp9', 'prores'];
  const VIDEO_PRESETS = ['fast', 'medium', 'slow'];
  const VIDEO_WIDTHS = [0, 1920, 1280, 854, 640];

  const DEFAULTS = {
    video: {
      codec: 'h264',
      quality: 'copy',
      crf: 16,
      preset: 'medium',
      bitrateKbps: 8000,
      targetMB: 10,
      encoder: 'cpu',
      maxWidth: 0,
      audioMode: 'original',
    },
    photo: {
      format: 'original',
      quality: 'max',
      keepMetadata: true,
      maxEdge: 0,
    },
    gif: {
      width: 480,
      fps: 12,
      loop: 0,
      ratio: 'auto',
      maxSeconds: 0,
    },
    // Birleştirme: "auto" uyumlu videoları kayıpsız ekler, değilse yeniden kodlar.
    merge: {
      mode: 'auto',
      codec: 'h264',
      crf: 18,
      preset: 'medium',
      encoder: 'cpu',
      audioMode: 'original',
    },
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function even(value, min = 2) {
    const rounded = Math.max(min, Math.round(Number(value) || 0));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  }

  function defaultsFor(kind) {
    const source = DEFAULTS[kind];
    return source ? { ...source } : {};
  }

  function normalizeKind(kind) {
    return ['video', 'photo', 'gif', 'merge'].includes(kind) ? kind : 'video';
  }

  function normalizeMergeSettings(settings = {}) {
    const base = defaultsFor('merge');
    return {
      mode: settings.mode === 'reencode' ? 'reencode' : 'auto',
      codec: ['h264', 'h265', 'vp9'].includes(settings.codec) ? settings.codec : base.codec,
      crf: clamp(Math.round(Number(settings.crf) || base.crf), 10, 30),
      preset: VIDEO_PRESETS.includes(settings.preset) ? settings.preset : base.preset,
      encoder: settings.encoder === 'gpu' ? 'gpu' : 'cpu',
      audioMode: settings.audioMode === 'none' ? 'none' : 'original',
    };
  }

  function normalizeVideoSettings(settings = {}) {
    const base = defaultsFor('video');
    const codec = VIDEO_CODECS.includes(settings.codec) ? settings.codec : base.codec;
    let quality = ['copy', 'crf', 'bitrate', 'size'].includes(settings.quality) ? settings.quality : base.quality;
    if (codec === 'prores' && (quality === 'bitrate' || quality === 'size')) quality = 'crf';
    return {
      codec,
      quality,
      crf: clamp(Math.round(Number(settings.crf) || base.crf), 10, 30),
      preset: VIDEO_PRESETS.includes(settings.preset) ? settings.preset : base.preset,
      bitrateKbps: clamp(Math.round(Number(settings.bitrateKbps) || base.bitrateKbps), 100, 200000),
      targetMB: Number(settings.targetMB) > 0
        ? Math.round(clamp(Number(settings.targetMB), 0.1, shared.SIZE_MAX_MB) * 10) / 10
        : base.targetMB,
      encoder: settings.encoder === 'gpu' ? 'gpu' : 'cpu',
      maxWidth: VIDEO_WIDTHS.includes(Number(settings.maxWidth)) ? Number(settings.maxWidth) : 0,
      audioMode: ['original', 'none', 'aac'].includes(settings.audioMode) ? settings.audioMode : base.audioMode,
    };
  }

  function normalizePhotoSettings(settings = {}) {
    const base = defaultsFor('photo');
    return {
      format: PHOTO_FORMATS.includes(settings.format) ? settings.format : base.format,
      quality: ['max', 'high', 'balanced'].includes(settings.quality) ? settings.quality : base.quality,
      keepMetadata: settings.keepMetadata !== false,
      maxEdge: [0, 3840, 2560, 1920, 1280, 1080, 800].includes(Number(settings.maxEdge))
        ? Number(settings.maxEdge)
        : 0,
    };
  }

  function normalizeGifSettings(settings = {}) {
    const base = defaultsFor('gif');
    const width = Math.round(Number(settings.width) || base.width);
    const fps = Number(settings.fps);
    const loop = Number(settings.loop);
    const seconds = Number(settings.maxSeconds);
    return {
      width: clamp(width, 160, 960),
      fps: GIF_FPS_VALUES.includes(fps) ? fps : base.fps,
      loop: Number.isFinite(loop) ? clamp(Math.round(loop), 0, 20) : base.loop,
      ratio: GIF_RATIO_VALUES.includes(String(settings.ratio)) ? String(settings.ratio) : base.ratio,
      maxSeconds: [0, 3, 5, 10, 15, 30].includes(seconds) ? seconds : 0,
    };
  }

  function normalizeSettings(kind, settings) {
    if (kind === 'photo') return normalizePhotoSettings(settings);
    if (kind === 'gif') return normalizeGifSettings(settings);
    if (kind === 'merge') return normalizeMergeSettings(settings);
    return normalizeVideoSettings(settings);
  }

  // Boyut seçimi uzun kenar için bir üst sınırdır (ayar adı geriye dönük
  // uyumluluk için "maxWidth" kalır): dikey videolar da yatay olanlarla aynı
  // ölçüde küçülür, küçük kaynaklar büyütülmez, en-boy oranı korunur ve
  // H.264/H.265 için çift piksel üretilir.
  function videoResize(settings, meta) {
    const normalized = normalizeVideoSettings(settings);
    const target = normalized.maxWidth;
    const width = Math.max(1, Number(meta?.width) || 0);
    const height = Math.max(1, Number(meta?.height) || 0);
    if (!target || width < 2 || height < 2 || Math.max(width, height) <= target) return null;
    const landscape = width >= height;
    const outWidth = landscape ? even(target) : even(Math.round((width * target) / height));
    const outHeight = landscape ? even(Math.round((height * target) / width)) : even(target);
    if (outWidth < 2 || outHeight < 2) return null;
    return { width: outWidth, height: outHeight };
  }

  function buildVideoOptions(settings, meta) {
    const normalized = normalizeVideoSettings(settings);
    const resize = videoResize(normalized, meta);
    let mode = normalized.quality;
    if (resize && mode === 'copy') mode = 'crf';
    if ((mode === 'bitrate' || mode === 'size') && normalized.codec === 'prores') mode = 'crf';
    const duration = Math.max(0, Number(meta?.duration) || 0);
    return {
      trimStart: 0,
      trimEnd: duration,
      rotation: 0,
      flipH: false,
      flipV: false,
      crop: null,
      resize,
      speed: 1,
      audioMode: meta?.hasAudio ? normalized.audioMode : 'none',
      mode,
      codec: normalized.codec,
      crf: normalized.crf,
      preset: normalized.preset,
      bitrateKbps: normalized.bitrateKbps,
      targetMB: normalized.targetMB,
      encoder: normalized.encoder,
    };
  }

  function photoOps(settings, meta) {
    const normalized = normalizePhotoSettings(settings);
    const target = normalized.maxEdge;
    const width = Math.max(1, Number(meta?.width) || 0);
    const height = Math.max(1, Number(meta?.height) || 0);
    if (!target || Math.max(width, height) <= target) return [];
    if (width >= height) {
      return [{ type: 'resize', width: target, height: Math.max(1, Math.round((height * target) / width)) }];
    }
    return [{ type: 'resize', width: Math.max(1, Math.round((width * target) / height)), height: target }];
  }

  function buildPhotoOptions(settings) {
    const normalized = normalizePhotoSettings(settings);
    return {
      format: normalized.format,
      quality: normalized.quality,
      keepMetadata: normalized.keepMetadata,
    };
  }

  function buildGifSettings(settings) {
    const normalized = normalizeGifSettings(settings);
    return {
      width: normalized.width,
      fps: normalized.fps,
      loop: normalized.loop,
      ratio: normalized.ratio,
    };
  }

  function gifFrames(durationSeconds, fps) {
    return Math.ceil(Math.max(0, Number(durationSeconds) || 0) * (Number(fps) || 12));
  }

  function gifLimitMessage(meta, seconds) {
    const name = meta?.name || 'Medya';
    return `${name}: GIF için seçilen aralık ${seconds.toFixed(1)} sn. En fazla ${GIF_MAX_DURATION} sn / ${GIF_MAX_FRAMES} kare olabilir; süre sınırını azaltın veya GIF modunda kırpın.`;
  }

  // Her kaynak ayrı bir GIF olacak şekilde tek kliplik plan girdisi üretir.
  // Videolarda isteğe bağlı ilk N saniye alınır; fotoğraflar 2 saniye görünür.
  function buildGifItem(settings, meta, filePath) {
    const normalized = normalizeGifSettings(settings);
    const path = String(filePath || meta?.path || '');
    if (!path || !meta) throw new Error('GIF kaynağı bulunamadı.');
    const ratio = normalized.ratio === 'auto' ? null : normalized.ratio;
    if (meta.kind === 'video') {
      const sourceDuration = Math.max(0, Number(meta.duration) || 0);
      if (!(sourceDuration > 0)) throw new Error(`${meta.name || 'Video'} süresi okunamadı.`);
      const seconds = normalized.maxSeconds > 0
        ? Math.min(sourceDuration, normalized.maxSeconds)
        : sourceDuration;
      const frames = gifFrames(seconds, normalized.fps);
      if (seconds <= 0) throw new Error(`${meta.name || 'Video'} için geçerli bir süre bulunamadı.`);
      if (seconds > GIF_MAX_DURATION || frames > GIF_MAX_FRAMES) {
        throw new Error(gifLimitMessage(meta, seconds));
      }
      return {
        path,
        trimStart: 0,
        trimEnd: seconds,
        speed: 1,
        ...(ratio ? { cropRatio: ratio } : {}),
      };
    }
    if (meta.kind !== 'image') {
      throw new Error(`${meta.name || 'Dosya'} GIF kaynağı olarak kullanılamıyor.`);
    }
    return {
      path,
      duration: 2,
      ...(ratio ? { cropRatio: ratio } : {}),
    };
  }

  function suggestName(fileName, kind) {
    const source = String(fileName || '').trim() || (kind === 'gif' ? 'odak-gif' : 'odak-cikti');
    const suffix = kind === 'gif' ? '-gif' : '-odak';
    return source.toLowerCase().endsWith(suffix) ? source : `${source}${suffix}`;
  }

  return {
    GIF_MAX_DURATION,
    GIF_MAX_FRAMES,
    GIF_FPS_VALUES,
    GIF_RATIO_VALUES,
    PHOTO_FORMATS,
    VIDEO_CODECS,
    VIDEO_PRESETS,
    VIDEO_WIDTHS,
    DEFAULTS,
    defaultsFor,
    normalizeKind,
    normalizeSettings,
    normalizeVideoSettings,
    normalizePhotoSettings,
    normalizeGifSettings,
    normalizeMergeSettings,
    videoResize,
    buildVideoOptions,
    photoOps,
    buildPhotoOptions,
    buildGifSettings,
    buildGifItem,
    gifFrames,
    suggestName,
  };
}));
