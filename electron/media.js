'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  execFileAsync,
  exists,
  parseRate,
  clamp,
  ffmpegError,
} = require('./util');

const shared = require('../src/shared.js');

const VIDEO_EXTENSIONS = new Set(shared.VIDEO_EXTENSIONS.map((ext) => `.${ext}`));
const IMAGE_EXTENSIONS = new Set(shared.IMAGE_EXTENSIONS.map((ext) => `.${ext}`));

function isVideoPath(file) {
  return VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function isImagePath(file) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function engineCandidateList() {
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [];
  if (process.env.ODAK_FFMPEG) list.push(process.env.ODAK_FFMPEG);
  list.push(path.join(__dirname, '..', 'bin', binary));
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'bin', binary));
  list.push(binary);
  return [...new Set(list)];
}

function siblingProbeFor(ffmpegPath) {
  const dir = path.dirname(ffmpegPath);
  if (dir === '.' || !path.isAbsolute(ffmpegPath)) {
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  }
  return path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

async function detectEngine() {
  for (const candidate of engineCandidateList()) {
    try {
      const { stdout } = await execFileAsync(candidate, ['-version']);
      const versionMatch = stdout.match(/ffmpeg version\s+([^\s]+)/i);
      const probe = siblingProbeFor(candidate);
      await execFileAsync(probe, ['-version']);
      return {
        available: true,
        ffmpeg: candidate,
        ffprobe: probe,
        version: versionMatch ? versionMatch[1] : 'bilinmiyor',
      };
    } catch {
      // Try the next candidate.
    }
  }
  return { available: false, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: null };
}

async function ffprobeJson(engine, file) {
  if (!engine.available) {
    throw new Error('FFmpeg bulunamadı. Kurup PATH değişkenine ekleyin veya uygulamayı ffmpeg ile birlikte paketleyin.');
  }
  try {
    const { stdout } = await execFileAsync(engine.ffprobe, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      file,
    ]);
    return JSON.parse(stdout);
  } catch (error) {
    const err = new Error('Video okunamadı. Dosya bozuk olabilir veya bu codec desteklenmiyor.');
    err.details = String(error.stderr || error.message || '').split(/\r?\n/).slice(-6).join('\n');
    throw err;
  }
}

function normalizeRotation(stream) {
  let rotation = Number(stream?.tags?.rotate);
  if (!Number.isFinite(rotation)) rotation = 0;
  if (!rotation && Array.isArray(stream?.side_data_list)) {
    for (const data of stream.side_data_list) {
      if (Number.isFinite(Number(data.rotation))) {
        rotation = Number(data.rotation);
        break;
      }
    }
  }
  rotation = Math.round(rotation / 90) * 90;
  rotation = ((rotation % 360) + 360) % 360;
  return rotation;
}

// FFprobe'un bits_per_raw_sample alanı her dosyada dolu değildir. Piksel
// formatından bit derinliğini güvenilir biçimde çıkar; özellikle p010/p016
// gibi "p0xx" adlandırması eski basit regex'te 1 bit sanılıyordu.
function pixelBitDepth(pixFmt) {
  const fmt = String(pixFmt || '').toLowerCase();
  if (!fmt) return 8;
  const semiPlanar = fmt.match(/^p[024]1([06])/);
  if (semiPlanar) return semiPlanar[1] === '0' ? 10 : 16;
  let match = fmt.match(/p(\d{1,2})(?:le|be)?$/);
  if (match) {
    const bits = Number(match[1]);
    if (bits >= 9) return bits;
  }
  match = fmt.match(/(\d{2})(?:le|be)$/);
  if (match) {
    const bits = Number(match[1]);
    if ([9, 10, 12, 14, 16].includes(bits)) return bits;
    if (bits === 32) return 10;
    if (bits === 48 || bits === 64) return 16;
  }
  return 8;
}

async function probeVideo(engine, file) {
  const info = await ffprobeJson(engine, file);
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new Error('Dosyada video akışı bulunamadı.');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audio = audioStreams[0];
  const trackInfo = (s) => ({ codec: s.codec_name || '', language: s.tags?.language || '' });
  const format = info.format || {};
  const stat = await fsp.stat(file);

  const rotation = normalizeRotation(video);
  const codedWidth = Number(video.width) || 0;
  const codedHeight = Number(video.height) || 0;
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? codedHeight : codedWidth;
  const height = swap ? codedWidth : codedHeight;
  const duration = Number(format.duration || video.duration || 0) || 0;
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 0;

  let videoBitrate = Number(video.bit_rate) || 0;
  let audioBitrate = Number(audio?.bit_rate) || 0;
  const overallBitrate = Number(format.bit_rate) || (duration > 0 ? (stat.size * 8) / duration : 0);
  if (!videoBitrate) {
    videoBitrate = Math.max(0, overallBitrate - audioBitrate);
  }

  const pixFmt = video.pix_fmt || '';
  const rawBits = Number(video.bits_per_raw_sample) || 0;
  const bitDepth = Math.max(rawBits, pixelBitDepth(pixFmt));
  const colorTransfer = video.color_transfer || '';
  const colorPrimaries = video.color_primaries || '';
  const colorSpace = video.color_space || '';
  // HDR, transfer fonksiyonuyla belirlenir. Yalnızca bt2020 primaries taşıyan
  // 10-bit SDR (bt709 transfer) videolar HDR sanılmamalı; aksi halde çıktıya
  // yanlışlıkla PQ/HLG etiketi eklenir.
  const isHdr = ['smpte2084', 'arib-std-b67'].includes(colorTransfer);
  const hasDolbyVision = (video.side_data_list || []).some((s) => /dovi|dolby/i.test(s.side_data_type || ''));

  return {
    kind: 'video',
    path: file,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    size: stat.size,
    width,
    height,
    codedWidth,
    codedHeight,
    rotation,
    duration,
    fps,
    videoCodec: video.codec_name || '',
    timeBase: video.time_base || '',
    videoCodecLong: video.codec_long_name || '',
    profile: video.profile || '',
    level: video.level || null,
    pixFmt,
    bitDepth,
    isHdr,
    hasDolbyVision,
    colorPrimaries,
    colorTransfer,
    colorSpace,
    videoBitrate,
    overallBitrate,
    container: format.format_name || '',
    containerLong: format.format_long_name || '',
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || '',
    audioBitrate,
    audioChannels: Number(audio?.channels) || 0,
    audioSampleRate: Number(audio?.sample_rate) || 0,
    audioTracks: audioStreams.map(trackInfo),
    subtitleTracks: streams.filter((s) => s.codec_type === 'subtitle').map(trackInfo),
    attachmentCount: streams.filter((s) => s.codec_type === 'attachment').length,
    hasChapters: (info.chapters || []).length > 0,
    streamCount: streams.length,
  };
}

function sharpBitDepth(depth) {
  if (depth === 'ushort' || depth === 'short') return 16;
  if (depth === 'uint' || depth === 'int' || depth === 'float' || depth === 'double') return 32;
  return 8;
}

async function probeImage(file) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    throw new Error('Görsel motoru yüklenemedi.');
  }
  let meta;
  try {
    meta = await sharp(file, { failOn: 'none', animated: false }).metadata();
  } catch (error) {
    throw new Error('Görsel açılamadı. Format desteklenmiyor olabilir.');
  }
  if (!meta.width || !meta.height) throw new Error('Görsel boyutları okunamadı.');
  const stat = await fsp.stat(file);
  const orientation = Number(meta.orientation) || 1;
  const swap = orientation >= 5 && orientation <= 8;
  const ext = path.extname(file).slice(1).toLowerCase();
  // Sharp, AVIF dosyalarını da "heif" olarak raporlar. AV1 sıkıştırmalı HEIF
  // aslında AVIF'tir; arayüzde ve dışa aktarmada doğru formatı kullan.
  let format = meta.format || ext;
  if (format === 'heif' && (meta.compression === 'av1' || ext === 'avif')) format = 'avif';
  return {
    kind: 'image',
    path: file,
    name: path.basename(file),
    ext,
    size: stat.size,
    format,
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
    storedWidth: meta.width,
    storedHeight: meta.height,
    orientation,
    hasAlpha: Boolean(meta.hasAlpha),
    channels: meta.channels || 0,
    bitDepth: sharpBitDepth(meta.depth),
    colorSpace: meta.space || '',
    density: meta.density || null,
    isAnimated: (meta.pages || 1) > 1,
    pages: meta.pages || 1,
    duration: null,
    fps: null,
    videoCodec: '',
    hasAudio: false,
  };
}

async function probeMedia(engine, file) {
  const ext = path.extname(file).toLowerCase();
  if (isImagePath(file)) return probeImage(file);
  if (isVideoPath(file)) return probeVideo(engine, file);
  try {
    return await probeVideo(engine, file);
  } catch {
    return probeImage(file);
  }
}

const FILMSTRIP_FRAMES = 12;

// Film şeridi için her kareye ayrı bir hızlı atlama (-ss giriş seçeneği) ile
// gidilir; yalnızca anahtar kareden itibaren birkaç kare çözülür. Böylece süre
// video uzunluğundan bağımsızdır. Kareler aralıkların ortasından alınır ki
// son kareye atlama boş sonuç vermesin.
function buildFilmstripArgs(input, duration, outputPath, frames = FILMSTRIP_FRAMES) {
  const total = Math.max(0.2, Number(duration) || 0.2);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const scaled = [];
  const labels = [];
  for (let index = 0; index < frames; index += 1) {
    const time = (total * (index + 0.5)) / frames;
    args.push('-ss', time.toFixed(3), '-i', input);
    scaled.push(`[${index}:v:0]scale=200:-2:flags=bicubic,setsar=1[f${index}]`);
    labels.push(`[f${index}]`);
  }
  const graph = `${scaled.join(';')};${labels.join('')}hstack=inputs=${frames}`;
  args.push('-filter_complex', graph, '-frames:v', '1', '-an', '-q:v', '5', outputPath);
  return args;
}

async function makeFilmstrip(engine, input, duration, outputPath) {
  try {
    await execFileAsync(engine.ffmpeg, buildFilmstripArgs(input, duration, outputPath));
    if (await exists(outputPath)) return;
  } catch {
    // Bazı kapsayıcılarda atlama başarısız olabilir; tüm videoyu tarayan
    // yavaş ama güvenilir yönteme düş.
  }
  const total = Math.max(0.2, Number(duration) || 0.2);
  const frames = FILMSTRIP_FRAMES;
  const fps = clamp(frames / total, 0.02, 30);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-t', total.toFixed(3),
    '-vf', `fps=${fps.toFixed(6)},scale=200:-2:flags=bicubic,tile=${frames}x1:padding=0`,
    '-frames:v', '1',
    '-q:v', '5',
    outputPath,
  ];
  await execFileAsync(engine.ffmpeg, args);
  if (!(await exists(outputPath))) throw new Error('Film şeridi oluşturulamadı.');
}

async function makePoster(engine, input, time, outputPath) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Math.max(0, Number(time) || 0).toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', 'scale=1280:-2:flags=lanczos',
    '-q:v', '3',
    outputPath,
  ];
  await execFileAsync(engine.ffmpeg, args);
  if (!(await exists(outputPath))) throw new Error('Önizleme karesi oluşturulamadı.');
}

function copyContainer(meta) {
  const ext = `.${String(meta.ext || '').toLowerCase()}`;
  if (ext === '.mp4' || ext === '.m4v') return 'mp4';
  if (ext === '.mov') return 'mov';
  if (ext === '.webm') return 'webm';
  return 'mkv';
}

function codecContainer(codec) {
  if (codec === 'h265') return 'mp4';
  if (codec === 'vp9') return 'webm';
  if (codec === 'prores') return 'mov';
  return 'mp4';
}

// Kesim bölümleri (kaynak saniyesi). options.segments boşsa trimStart/trimEnd
// tek bölümdür. Bölümler zaman sırasına dizilir; örtüşen ya da bitişik
// bölümler tek bölümde birleşir, 0,04 sn'den kısa olanlar atılır.
function normalizeSegments(options, duration) {
  const total = Math.max(0, Number(duration) || 0);
  if (Array.isArray(options.segments) && options.segments.length) {
    const list = options.segments
      .map((segment) => {
        const start = clamp(Number(segment?.start) || 0, 0, total);
        const end = clamp(Number(segment?.end) || 0, 0, total);
        return { start, end };
      })
      .filter((segment) => segment.end - segment.start >= 0.04)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const segment of list) {
      const last = merged[merged.length - 1];
      if (last && segment.start <= last.end + 0.001) last.end = Math.max(last.end, segment.end);
      else merged.push({ ...segment });
    }
    if (merged.length) return merged;
  }
  const start = clamp(Number(options.trimStart) || 0, 0, total);
  const end = clamp(Number(options.trimEnd) || total, start, total);
  return [{ start, end: Math.max(end, start + 0.001) }];
}

function planVideo(meta, options) {
  const copyMode = options.mode === 'copy';
  let container = copyMode ? copyContainer(meta) : codecContainer(options.codec);
  if (copyMode && options.audioMode === 'aac' && container === 'webm') container = 'mkv';
  const segments = normalizeSegments(options, meta.duration);
  const sourceDuration = Math.max(0.001, segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0));
  const speed = clamp(Number(options.speed) || 1, 0.25, 4);
  const duration = sourceDuration / speed;
  return {
    container,
    ext: `.${container}`,
    sourceDuration,
    duration,
    segments,
  };
}

function buildAtempo(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters;
}

// Döndürme, çevirme, kırpma ve yeniden boyutlandırma. Video ve tek kare
// çıktısında aynı sırayla uygulanır; kırpma koordinatları döndürülmüş
// görüntü uzayındadır (UI de bu uzayda çalışır).
function buildGeometryFilters(options) {
  const filters = [];
  const rotation = ((Math.round((Number(options.rotation) || 0) / 90) * 90) % 360 + 360) % 360;
  const flipH = Boolean(options.flipH);
  const flipV = Boolean(options.flipV);
  const crop = options.crop;
  const resize = options.resize;

  if (rotation === 90) filters.push('transpose=1');
  else if (rotation === 180) filters.push('hflip', 'vflip');
  else if (rotation === 270) filters.push('transpose=2');
  if (flipH) filters.push('hflip');
  if (flipV) filters.push('vflip');

  if (crop) {
    const w = Math.max(2, Math.round(Number(crop.width) || 0));
    const h = Math.max(2, Math.round(Number(crop.height) || 0));
    const x = Math.max(0, Math.round(Number(crop.x) || 0));
    const y = Math.max(0, Math.round(Number(crop.y) || 0));
    filters.push(`crop=${w}:${h}:${x}:${y}`);
  }

  if (resize) {
    const w = Math.max(2, Math.round(Number(resize.width) || 0));
    const h = Math.max(2, Math.round(Number(resize.height) || 0));
    filters.push(`scale=${w}:${h}:flags=lanczos`);
  }

  return filters;
}

// overlay: geometriden sonra, hız değişiminden önce uygulanan metin/altyazı
// filtreleri (overlayFilters çıktısı). Metin böylece son kadraja çizilir.
function buildVideoFilters(options, meta = {}, overlay = []) {
  return [...buildGeometryFilters(options), ...overlay, ...buildPostFilters(options, meta)];
}

// Hız, kare hızı ve çift boyut: çok bölümlü kesimde bölümler birleştikten
// sonra bir kez uygulanır.
function buildPostFilters(options, meta = {}) {
  const filters = [];
  const speed = clamp(Number(options.speed) || 1, 0.25, 4);
  if (Math.abs(speed - 1) > 0.0001) {
    filters.push(`setpts=PTS/${speed}`);
    // Hızlandırma kare sıklığını katlar; kareler kaynağın hızına filtre içinde
    // indirilir. Aksi halde düşürme kapsayıcıda yapılır, kodlayıcı fazladan
    // kare görür ve iki geçişli kodlamada bit hızı hesabı yarıya düşer.
    const fps = Number(meta.fps) || 0;
    if (fps > 0) filters.push(`fps=${Number(fps.toFixed(6))}`);
  }

  // 4:2:0 encoders need even dimensions. This only removes a single edge
  // pixel when the source or a crop happens to be odd-sized.
  filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');

  return filters;
}

// Tek kare PNG çıktısı için: hız ve çift boyut zorlaması yok, PNG tek piksel
// kaybı yaşamadan tek/çift boyutları destekler.
function buildFrameFilters(options, overlay = []) {
  return [...buildGeometryFilters(options), ...overlay];
}

function burnSubtitleIndex(options) {
  const index = Number(options.burnSubtitle);
  return Number.isInteger(index) && index >= 0 ? index : -1;
}

function hasOverlays(options) {
  return shared.cleanTextLayers(options.textLayers).length > 0 || burnSubtitleIndex(options) >= 0;
}

function isCopyAllowed(options) {
  return !options.rotation && !options.flipH && !options.flipV && !options.crop && !options.resize &&
    Math.abs((Number(options.speed) || 1) - 1) < 0.0001 && !hasOverlays(options);
}

// Döndürme/kırpma/boyutlandırma sonrası görüntü boyutu: metin bu boyuttaki
// kareye çizilir. Video çıktısı çift piksele yuvarlanır, tek kare olduğu gibi kalır.
function geometryOutputSize(meta, options, { evenSize = true } = {}) {
  let width = Number(meta.width) || 0;
  let height = Number(meta.height) || 0;
  const rotation = ((Math.round((Number(options.rotation) || 0) / 90) * 90) % 360 + 360) % 360;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  if (options.crop) {
    width = Math.max(2, Math.round(Number(options.crop.width) || width));
    height = Math.max(2, Math.round(Number(options.crop.height) || height));
  }
  if (options.resize) {
    width = Math.max(2, Math.round(Number(options.resize.width) || width));
    height = Math.max(2, Math.round(Number(options.resize.height) || height));
  }
  if (evenSize) {
    width = Math.floor(width / 2) * 2;
    height = Math.floor(height / 2) * 2;
  }
  return { width: Math.max(2, width), height: Math.max(2, height) };
}

const BURNABLE_SUBTITLES = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'text', 'mov_text'];

// Metin katmanları ve yakılacak altyazı için geçici bir iş klasörü hazırlar.
// FFmpeg bu klasörde çalıştırılır; filtrelere yalnızca göreli, güvenli dosya
// adları verilir (Windows yollarındaki ":" ve "\" filtre sözdizimini bozar).
async function prepareOverlays(engine, input, meta, options, outputSize) {
  const layers = shared.cleanTextLayers(options.textLayers);
  const burnIndex = burnSubtitleIndex(options);
  if (!layers.length && burnIndex < 0) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-job-'));
  const filters = [];
  try {
    if (burnIndex >= 0) {
      const track = meta.subtitleTracks?.[burnIndex];
      if (!track) throw new Error('Yakılacak altyazı izi bulunamadı.');
      if (!BURNABLE_SUBTITLES.includes(track.codec)) {
        throw new Error('Bu altyazı resim tabanlı (PGS/DVD); yalnızca metin altyazılar videoya yakılabilir.');
      }
      try {
        await execFileAsync(engine.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', input, '-map', `0:s:${burnIndex}`, '-c:s', 'ass', 'subs.ass',
        ], { cwd: dir });
      } catch (error) {
        throw ffmpegError(error.stderr, 'Altyazı izi okunamadı.');
      }
      // ASS altyazıların gömülü yazı tipleri (MKV ekleri) varsa kullan.
      let fontsdir = '';
      if (meta.attachmentCount > 0) {
        await fsp.mkdir(path.join(dir, 'fonts'));
        await execFileAsync(engine.ffmpeg, ['-hide_banner', '-loglevel', 'quiet', '-y', '-dump_attachment:t', '', '-i', input], {
          cwd: path.join(dir, 'fonts'),
        }).catch(() => {});
        fontsdir = ':fontsdir=fonts';
      }
      filters.push(`subtitles=subs.ass${fontsdir}`);
    }
    if (layers.length) {
      const document = shared.buildAssDocument({ ...outputSize, layers, defaultEnd: (Number(meta.duration) || 0) + 3600 });
      await fsp.writeFile(path.join(dir, 'text.ass'), `﻿${document}`, 'utf8');
      filters.push('subtitles=text.ass');
    }
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    dir,
    filters,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

// Metin ve altyazı kaynak zaman çizelgesine göre zamanlanır. "-ss" ile kesilen
// videoda kareler 0'dan başladığı için zaman geçici olarak kesim başına kaydırılır.
function overlayFilters(overlay, shift) {
  if (!overlay || !overlay.filters.length) return [];
  const offset = Math.max(0, Number(shift) || 0);
  if (offset <= 0.0005) return [...overlay.filters];
  return [`setpts=PTS+${offset.toFixed(6)}/TB`, ...overlay.filters, 'setpts=PTS-STARTPTS'];
}

const MOV_AUDIO_COPY = new Set([
  'aac', 'mp3', 'ac3', 'eac3', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le',
]);

// Tüm ses izleri çıktıya alınır ve aynı codec kararıyla yazılır. Bu yüzden
// kopyalama ancak her iz kapsayıcıyla uyumluysa seçilir.
function audioCodecs(meta) {
  const tracks = Array.isArray(meta.audioTracks) && meta.audioTracks.length
    ? meta.audioTracks.map((track) => track.codec)
    : [meta.audioCodec];
  return tracks.map((codec) => String(codec || ''));
}

function pickAudioStrategy(meta, options, container, speed) {
  if (!meta.hasAudio || options.audioMode === 'none') {
    return { enabled: false };
  }
  const wantsAac = options.audioMode === 'aac';
  const audioFilterNeeded = Math.abs(speed - 1) > 0.0001;
  const reencodeVideo = options.mode !== 'copy';
  const codecs = audioCodecs(meta);
  const allIn = (allowed) => codecs.every((codec) => allowed.includes(codec));
  if (!wantsAac && !audioFilterNeeded) {
    if (container === 'webm' && !allIn(['opus', 'vorbis'])) {
      return { enabled: true, codec: 'libopus', bitrate: '256k' };
    }
    if (container === 'mp4' && !allIn(['aac', 'mp3', 'ac3', 'eac3'])) {
      return { enabled: true, codec: 'aac', bitrate: '320k' };
    }
    if (reencodeVideo && container === 'mov' && options.codec === 'prores' && !allIn([...MOV_AUDIO_COPY])) {
      return { enabled: true, codec: 'pcm_s24le' };
    }
    return { enabled: true, codec: 'copy' };
  }
  if (container === 'webm') return { enabled: true, codec: 'libopus', bitrate: '256k' };
  if (reencodeVideo && container === 'mov' && options.codec === 'prores') {
    return { enabled: true, codec: 'pcm_s24le' };
  }
  return { enabled: true, codec: 'aac', bitrate: '320k' };
}

const TEXT_SUBTITLES = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'text', 'mov_text'];
const BITMAP_SUBTITLES = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];

// Altyazılar kapsayıcının taşıyabildiği biçimde korunur: MKV metin ve resim
// altyazıyı olduğu gibi alır; MP4/MOV ve WebM yalnızca metin altyazı taşır,
// bunlar kapsayıcının kendi biçimine çevrilir. Taşınamayanlar atlanır.
function pickSubtitleStrategy(meta, container) {
  const tracks = Array.isArray(meta.subtitleTracks) ? meta.subtitleTracks : [];
  let allowed;
  let codec;
  if (container === 'mkv') {
    allowed = [...TEXT_SUBTITLES.filter((name) => name !== 'mov_text'), ...BITMAP_SUBTITLES];
    codec = 'copy';
  } else if (container === 'mp4' || container === 'mov') {
    allowed = TEXT_SUBTITLES;
    codec = 'mov_text';
  } else if (container === 'webm') {
    allowed = TEXT_SUBTITLES;
    codec = 'webvtt';
  } else {
    return { indexes: [], skipped: tracks.length };
  }
  const indexes = [];
  tracks.forEach((track, index) => {
    if (allowed.includes(String(track.codec || ''))) indexes.push(index);
  });
  return { indexes, codec, skipped: tracks.length - indexes.length };
}

// ── Donanım (GPU) kodlama ───────────────────────────────────────────────
// NVIDIA NVENC, Intel Quick Sync ve AMD AMF; yalnızca H.264/H.265 için.
// Hangi kodlayıcının gerçekten çalıştığı açılışta küçük bir deneme
// kodlamasıyla belirlenir (FFmpeg'de derli olması sürücü/donanım olduğu
// anlamına gelmez). Deneme, dışa aktarmadaki argümanların aynısını kullanır.
const HW_VENDORS = ['nvenc', 'qsv', 'amf'];
const HW_ENCODERS = {
  nvenc: { h264: 'h264_nvenc', h265: 'hevc_nvenc' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf' },
};
const HW_LABELS = { nvenc: 'NVIDIA NVENC', qsv: 'Intel Quick Sync', amf: 'AMD AMF' };

function hardwareVideoArgs(vendor, codec, { mode = 'crf', crf = 16, preset = 'medium', bitrateKbps = 8000, tenBit = false } = {}) {
  const name = HW_ENCODERS[vendor]?.[codec];
  if (!name) throw new Error('Bu codec için donanım kodlayıcı yok.');
  const quality = String(Math.round(crf));
  const kbps = Math.max(50, Math.round(bitrateKbps));
  const rate = mode === 'crf' ? null : {
    bitrate: `${kbps}k`,
    maxrate: `${Math.round(kbps * 1.5)}k`,
    bufsize: `${kbps * 2}k`,
  };
  // H.264 donanım kodlayıcıları genelde 10-bit desteklemez; 10-bit yalnızca H.265'te.
  const deep = tenBit && codec === 'h265';
  const args = ['-c:v', name];
  if (vendor === 'nvenc') {
    args.push('-preset', { fast: 'p3', medium: 'p5', slow: 'p7' }[preset] || 'p5', '-tune', 'hq', '-rc', 'vbr');
    if (rate) {
      args.push('-b:v', rate.bitrate, '-maxrate', rate.maxrate, '-bufsize', rate.bufsize);
      if (mode === 'size') args.push('-multipass', 'fullres');
    } else {
      args.push('-cq', quality, '-b:v', '0');
    }
    args.push('-pix_fmt', deep ? 'p010le' : 'yuv420p');
  } else if (vendor === 'qsv') {
    args.push('-preset', { fast: 'veryfast', medium: 'medium', slow: 'veryslow' }[preset] || 'medium');
    if (rate) args.push('-b:v', rate.bitrate, '-maxrate', rate.maxrate, '-bufsize', rate.bufsize);
    else args.push('-global_quality', quality);
    args.push('-pix_fmt', deep ? 'p010le' : 'nv12');
  } else {
    args.push('-quality', { fast: 'speed', medium: 'balanced', slow: 'quality' }[preset] || 'balanced');
    if (rate) args.push('-rc', 'vbr_peak', '-b:v', rate.bitrate, '-maxrate', rate.maxrate, '-bufsize', rate.bufsize);
    else args.push('-rc', 'cqp', '-qp_i', quality, '-qp_p', quality);
    args.push('-pix_fmt', deep ? 'p010le' : 'yuv420p');
  }
  if (codec === 'h264') args.push('-profile:v', 'high');
  else args.push('-profile:v', deep ? 'main10' : 'main', '-tag:v', 'hvc1');
  return args;
}

async function detectHardwareEncoders(engine) {
  const result = { h264: [], h265: [], labels: HW_LABELS };
  if (!engine.available) return result;
  let compiled = '';
  try {
    compiled = (await execFileAsync(engine.ffmpeg, ['-hide_banner', '-encoders'])).stdout;
  } catch {
    return result;
  }
  for (const vendor of HW_VENDORS) {
    for (const codec of ['h264', 'h265']) {
      if (!compiled.includes(` ${HW_ENCODERS[vendor][codec]} `)) continue;
      try {
        await execFileAsync(engine.ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=black:s=256x256:r=30:d=0.2',
          ...hardwareVideoArgs(vendor, codec, { mode: 'crf', crf: 23 }),
          '-frames:v', '3', '-f', 'null', nullOutput(),
        ], { timeout: 15000 });
        result[codec].push(vendor);
      } catch {
        // Sürücü/donanım yok: bu kodlayıcı sunulmaz.
      }
    }
  }
  return result;
}

// İstenen GPU kodlamasının bu makinede hangi üreticiyle yapılacağı (yoksa null).
function resolveHardwareVendor(options, hardware) {
  if (options.encoder !== 'gpu' || options.mode === 'copy') return null;
  const codec = options.codec || 'h264';
  return hardware?.[codec]?.[0] || null;
}

function sizeAudioTrackCount(meta, options) {
  if (!meta.hasAudio || options.audioMode === 'none') return 0;
  return Math.max(1, Array.isArray(meta.audioTracks) ? meta.audioTracks.length : 1);
}

// Hedef boyut modunun bit hızları. Hedef bu süreye sığmıyorsa anlaşılır bir
// hata verir (en az kaç MB gerektiğiyle birlikte).
function planSizeMode(meta, options, plan) {
  const codec = options.codec || 'h264';
  if (codec === 'prores') throw new Error('ProRes hedef dosya boyutu modunu desteklemez.');
  // Bit hızı tavanı çözünürlükle orantılıdır: küçültülen görüntüye kaynağın
  // tam bit hızını vermek dosyayı boşuna büyük tutardı.
  const out = geometryOutputSize(meta, options);
  const pixelRatio = meta.width > 0 && meta.height > 0 && out.width > 0 && out.height > 0
    ? Math.min(1, (out.width * out.height) / (meta.width * meta.height))
    : 1;
  const rates = shared.sizeModeBitrates({
    targetMB: options.targetMB,
    duration: plan.duration,
    codec,
    audioTracks: sizeAudioTrackCount(meta, options),
    sourceVideoKbps: ((Number(meta.videoBitrate) || 0) / 1000) * clamp(Number(options.speed) || 1, 0.25, 4) * pixelRatio,
    sourceAudioKbps: (Number(meta.audioBitrate) || 0) / 1000,
  });
  if (!(rates.targetBytes > 0)) throw new Error('Geçerli bir hedef dosya boyutu girin.');
  if (!rates.feasible) {
    throw new Error(`Hedef boyut bu süre için çok küçük. En az ${rates.minMB.toLocaleString('tr-TR')} MB seçin, videoyu kısaltın veya sesi kapatın.`);
  }
  return rates;
}

function nullOutput() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

// Video kodlayıcı argümanları (işlemci veya GPU). mode: crf | bitrate | size.
// Hedef boyutta işlemci iki geçişli kodlar (pass 1/2, passLogFile); GPU
// kodlayıcı tek geçişte kendi çok geçişli moduyla çalışır.
function videoEncoderArgs({
  codec = 'h264', preset = 'medium', crf = 16, tenBit = false, hwVendor = null,
  mode = 'crf', bitrateKbps = 8000, pass = 0, passLogFile = 'odak-pass',
}) {
  const rateMode = (mode === 'bitrate' || mode === 'size') && codec !== 'prores';
  if (hwVendor) {
    return hardwareVideoArgs(hwVendor, codec, { mode: rateMode ? mode : 'crf', crf, preset, bitrateKbps, tenBit });
  }
  const args = [];
  if (codec === 'h264') {
    args.push('-c:v', 'libx264', '-preset', preset);
    if (!rateMode) args.push('-crf', String(crf));
    args.push('-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p');
    args.push('-profile:v', tenBit ? 'high10' : 'high');
  } else if (codec === 'h265') {
    args.push('-c:v', 'libx265', '-preset', preset);
    if (!rateMode) args.push('-crf', String(crf));
    args.push('-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p');
    args.push('-profile:v', tenBit ? 'main10' : 'main');
    args.push('-tag:v', 'hvc1');
  } else if (codec === 'vp9') {
    args.push('-c:v', 'libvpx-vp9');
    if (!rateMode) args.push('-crf', String(crf), '-b:v', '0');
    const cpu = preset === 'slow' ? '0' : preset === 'fast' ? '4' : '2';
    args.push('-deadline', 'good', '-cpu-used', cpu, '-row-mt', '1');
    args.push('-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p');
  } else if (codec === 'prores') {
    args.push('-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0');
    args.push('-pix_fmt', 'yuv422p10le');
  } else {
    throw new Error('Bilinmeyen video codec seçimi.');
  }
  if (mode === 'size' && rateMode) {
    // İki geçişli ortalama bit hızı: tepe sınırı konmaz, kodlayıcı bütçeyi
    // sahneler arasında serbestçe dağıtır.
    args.push('-b:v', `${bitrateKbps}k`, '-pass', String(pass || 2), '-passlogfile', passLogFile);
  } else if (rateMode) {
    args.push('-b:v', `${bitrateKbps}k`, '-maxrate', `${Math.round(bitrateKbps * 1.5)}k`, '-bufsize', `${bitrateKbps * 2}k`);
  }
  return args;
}

function audioEncoderArgs(audio) {
  if (!audio.enabled) return [];
  // -copyinkf:a: bazı MKV kayıtlarında ses paketleri "anahtar kare" diye
  // işaretlenmez; kopyalarken FFmpeg anahtar kare bekleyip sesi hiç yazmıyordu.
  if (audio.codec === 'copy') return ['-c:a', 'copy', '-copyinkf:a'];
  return ['-c:a', audio.codec, ...(audio.bitrate ? ['-b:a', audio.bitrate] : [])];
}

// Filtreden geçen ses kopyalanamaz; kapsayıcıya uygun kodlamaya çevrilir.
function encodedAudio(audio, container, codec) {
  if (!audio.enabled || audio.codec !== 'copy') return audio;
  if (container === 'webm') return { enabled: true, codec: 'libopus', bitrate: '256k' };
  if (container === 'mov' && codec === 'prores') return { enabled: true, codec: 'pcm_s24le' };
  return { enabled: true, codec: 'aac', bitrate: '320k' };
}

// extra.pass: 0 (tek geçiş), 1 (analiz, çıktı atılır) veya 2 (son kodlama).
// extra.videoKbps: hedef boyut modunda son geçişin yeniden denenmesi için
// hesaplanan bit hızının üzerine yazar. extra.overlay: metin/altyazı.
function buildVideoArgs(input, meta, options, tempPath, plan, extra = {}) {
  const { container } = plan;
  const speed = clamp(Number(options.speed) || 1, 0.25, 4);
  const copyMode = options.mode === 'copy';
  if (copyMode && !isCopyAllowed(options)) {
    throw new Error('Görsel değişiklikler varken kayıpsız kopyalama kullanılamaz.');
  }
  const segments = plan.segments || normalizeSegments(options, meta.duration);
  const segmented = segments.length > 1;
  if (copyMode && segmented) {
    // Kayıpsız çok bölümlü kesim, bölümler ayrı kesilip birleştirilerek yapılır (exportVideo).
    throw new Error('Çok bölümlü kayıpsız kesim bölüm bölüm yapılmalıdır.');
  }
  const sizeMode = options.mode === 'size';
  const size = sizeMode ? planSizeMode(meta, options, plan) : null;
  // GPU kodlayıcılar FFmpeg'in iki geçişli kaydını kullanmaz; hedef boyutta
  // tek geçişte kendi çok geçişli modlarıyla çalışır.
  const hwVendor = !copyMode && ['h264', 'h265'].includes(options.codec || 'h264') && HW_ENCODERS[options.hwVendor]
    ? options.hwVendor
    : null;
  const pass = sizeMode && !hwVendor ? (Number(extra.pass) || 2) : 0;
  const analysisPass = pass === 1;

  const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
  // -t giriş seçeneği olarak verilir: hız filtresi çıktı zaman damgalarını
  // sıkıştırdığı için çıktı -t'si kaynak aralığının speed katı kadar fazla
  // okunmasına yol açıyordu. Çok bölümlü kesimde her bölüm kendi hızlı
  // atlamasıyla ayrı bir giriş olarak açılır.
  for (const segment of segments) {
    if (segment.start > 0.001) args.push('-ss', segment.start.toFixed(6));
    args.push('-t', Math.max(0.001, segment.end - segment.start).toFixed(6), '-i', input);
  }

  let audio = pickAudioStrategy(meta, options, container, speed);
  if (size && audio.enabled) {
    // Boyut bütçesi sesi de kapsar; ses her zaman hesaplanan bit hızıyla kodlanır.
    audio = { enabled: true, codec: container === 'webm' ? 'libopus' : 'aac', bitrate: `${size.audioKbps}k` };
  }
  // Analiz geçişi yalnızca görüntüyü inceler; ses ve altyazı gerekmez.
  if (analysisPass) audio = { enabled: false };

  let subtitles = { indexes: [], skipped: 0 };
  if (segmented) {
    // Bölümler concat filtresiyle birleşir: yumuşak altyazı ve bölümler
    // (chapters) taşınamaz; ses filtreden geçtiği için yeniden kodlanır.
    audio = encodedAudio(audio, container, options.codec || 'h264');
    const audioTracks = audio.enabled ? Math.max(1, Array.isArray(meta.audioTracks) ? meta.audioTracks.length : 1) : 0;
    const geometry = buildGeometryFilters(options);
    const graph = [];
    const concatInputs = [];
    segments.forEach((segment, index) => {
      const chain = [...geometry, ...overlayFilters(extra.overlay, segment.start), 'setpts=PTS-STARTPTS'];
      graph.push(`[${index}:v:0]${chain.join(',')}[v${index}]`);
      concatInputs.push(`[v${index}]`);
      for (let track = 0; track < audioTracks; track += 1) {
        graph.push(`[${index}:a:${track}]asetpts=PTS-STARTPTS[a${index}_${track}]`);
        concatInputs.push(`[a${index}_${track}]`);
      }
    });
    const audioOut = Array.from({ length: audioTracks }, (unused, track) => `[ac${track}]`).join('');
    graph.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=${audioTracks}[vc]${audioOut}`);
    graph.push(`[vc]${buildPostFilters(options, meta).join(',')}[vout]`);
    const maps = ['-map', '[vout]'];
    for (let track = 0; track < audioTracks; track += 1) {
      if (Math.abs(speed - 1) > 0.0001) {
        graph.push(`[ac${track}]${buildAtempo(speed).join(',')}[ao${track}]`);
        maps.push('-map', `[ao${track}]`);
      } else {
        maps.push('-map', `[ac${track}]`);
      }
    }
    args.push('-filter_complex', graph.join(';'), ...maps);
    if (!audioTracks) args.push('-an');
    args.push('-sn', '-dn', '-map_metadata', '0', '-map_chapters', '-1');
  } else {
    args.push('-map', '0:v:0');
    if (audio.enabled) args.push('-map', '0:a?');
    else args.push('-an');
    // Videoya yakılan altyazı ayrıca yumuşak iz olarak eklenmez (çift görünmesin).
    const burnIndex = burnSubtitleIndex(options);
    // Çok bölümlü kayıpsız kesimin parçalarında altyazı yok: kopyalanan altyazı
    // olayları parça süresini uzatır ve concat sonraki parçayı yanlış kaydırır.
    if (!analysisPass && !options.segmentPart) {
      subtitles = pickSubtitleStrategy({
        ...meta,
        subtitleTracks: (meta.subtitleTracks || []).map((track, index) => (index === burnIndex ? { ...track, codec: 'burned' } : track)),
      }, container);
    }
    if (subtitles.indexes.length) {
      for (const index of subtitles.indexes) args.push('-map', `0:s:${index}`);
      args.push('-c:s', subtitles.codec);
    } else {
      args.push('-sn');
    }
    // MKV'deki gömülü yazı tipleri ASS altyazıların doğru görünmesi için gerekir.
    if (container === 'mkv' && subtitles.indexes.length && meta.attachmentCount > 0) {
      args.push('-map', '0:t?');
    }
    args.push('-dn');
    args.push('-map_metadata', '0', '-map_chapters', '0');
  }

  if (copyMode) {
    args.push('-c:v', 'copy', ...audioEncoderArgs(audio));
    args.push('-avoid_negative_ts', 'make_zero');
    if (container === 'mp4' || container === 'mov') args.push('-movflags', '+faststart');
  } else {
    if (!segmented) {
      const filters = buildVideoFilters(options, meta, overlayFilters(extra.overlay, segments[0].start));
      if (filters.length) args.push('-vf', filters.join(','));
      if (audio.enabled && Math.abs(speed - 1) > 0.0001) args.push('-af', buildAtempo(speed).join(','));
    }
    args.push(...audioEncoderArgs(audio));

    const codec = options.codec || 'h264';
    const bitrateKbps = sizeMode
      ? Math.max(shared.SIZE_MIN_VIDEO_KBPS, Math.round(Number(extra.videoKbps) || size.videoKbps))
      : Math.max(100, Math.round(Number(options.bitrateKbps) || (meta.videoBitrate / 1000) || 8000));
    args.push(...videoEncoderArgs({
      codec,
      preset: ['fast', 'medium', 'slow'].includes(options.preset) ? options.preset : 'medium',
      crf: clamp(Number(options.crf) || 16, 0, 51),
      tenBit: meta.bitDepth > 8,
      hwVendor,
      mode: sizeMode ? 'size' : options.mode === 'bitrate' ? 'bitrate' : 'crf',
      bitrateKbps,
      pass,
      passLogFile: extra.passLogFile || 'odak-pass',
    }));

    if (meta.isHdr) {
      const trc = meta.colorTransfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
      args.push('-color_primaries', 'bt2020');
      args.push('-color_trc', trc);
      args.push('-colorspace', 'bt2020nc');
    }

    if (!analysisPass && (container === 'mp4' || container === 'mov')) args.push('-movflags', '+faststart');
  }

  if (analysisPass) args.push('-f', 'null', nullOutput());
  else args.push(tempPath);
  return { args, audio, subtitles, size };
}

function parseProgressLine(line) {
  const index = line.indexOf('=');
  if (index < 0) return null;
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function runFfmpegProcess(engine, args, { duration, onProgress, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (!engine.available) {
      reject(new Error('FFmpeg bulunamadı.'));
      return;
    }
    let stderr = '';
    let stdoutBuffer = '';
    let lastSent = 0;
    let aborted = false;
    const state = {
      percent: 0,
      outSeconds: 0,
      speed: 0,
      fps: 0,
      bitrate: '',
    };
    const emitProgress = (force = false) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastSent < 120) return;
      lastSent = now;
      const eta = state.speed > 0 && duration
        ? Math.max(0, (duration - state.outSeconds) / state.speed)
        : 0;
      onProgress({
        percent: state.percent,
        outSeconds: state.outSeconds,
        speed: state.speed,
        fps: state.fps,
        bitrate: state.bitrate,
        etaSeconds: eta,
      });
    };
    const proc = spawn(engine.ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });

    const abortHandler = () => {
      aborted = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    };
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const pair = parseProgressLine(line);
        if (!pair) continue;
        const [key, value] = pair;
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const seconds = Number(value) / 1_000_000;
          if (!Number.isFinite(seconds)) continue;
          state.outSeconds = seconds;
          if (duration) state.percent = clamp((seconds / duration) * 100, 0, 99.6);
          emitProgress();
        } else if (key === 'speed') {
          state.speed = Number.parseFloat(value) || 0;
        } else if (key === 'fps') {
          state.fps = Number.parseFloat(value) || 0;
        } else if (key === 'bitrate') {
          state.bitrate = value;
        } else if (key === 'progress' && value === 'end') {
          state.percent = 100;
          emitProgress(true);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-16000);
    });

    proc.on('error', (error) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      reject(new Error(`FFmpeg başlatılamadı: ${error.message}`));
    });

    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      if (aborted) {
        const err = new Error('İşlem iptal edildi.');
        err.cancelled = true;
        reject(err);
        return;
      }
      if (code === 0) resolve({ stderr });
      else reject(ffmpegError(stderr, 'FFmpeg işlemi başarısız oldu.'));
    });
  });
}

// Hedef boyut modunda kaynak zaten hedefe sığıyor ve görsel değişiklik yoksa
// yeniden kodlamak yalnızca kaliteyi düşürür (çoğu zaman dosyayı da büyütür):
// o aralık kayıpsız kopyalanır.
function sizeFitsAsCopy(meta, options, plan) {
  if (options.mode !== 'size' || !isCopyAllowed(options)) return false;
  if (!['original', 'none'].includes(options.audioMode || 'original')) return false;
  if (copyContainer(meta) !== plan.container) return false;
  const duration = Number(meta.duration) || 0;
  const size = Number(meta.size) || 0;
  const targetBytes = (Number(options.targetMB) || 0) * 1e6;
  if (!(duration > 0 && size > 0 && targetBytes > 0)) return false;
  return (size * plan.sourceDuration) / duration <= targetBytes * 0.95;
}

async function exportVideo(engine, sourcePath, meta, options, tempPath, plan, { onProgress, signal } = {}) {
  // Yollar mutlak olmalı: metin/altyazı varsa FFmpeg iş klasöründe çalışır.
  const input = path.resolve(sourcePath);
  const output = path.resolve(tempPath);
  if (sizeFitsAsCopy(meta, options, plan)) {
    const copyOptions = { ...options, mode: 'copy' };
    const copied = await exportVideo(engine, input, meta, copyOptions, output, planVideo(meta, copyOptions), { onProgress, signal });
    const targetBytes = (Number(options.targetMB) || 0) * 1e6;
    if (copied.size <= targetBytes) return { ...copied, targetBytes, overTarget: false, keptSource: true };
    // Anahtar kare payı hedefi aştırdıysa normal hedef boyut kodlamasına geçilir.
  }
  const overlay = options.mode === 'copy'
    ? null
    : await prepareOverlays(engine, input, meta, options, geometryOutputSize(meta, options));
  try {
    if (wantsSmartCut(meta, options, plan)) {
      try {
        const result = await exportSmartCopy(engine, input, meta, options, output, plan, { onProgress, signal });
        const videoDuration = await videoStreamDuration(engine, output).catch(() => 0);
        // Görüntü süresi beklenenden belirgin farklıysa güvenli yola (anahtar
        // kare kopyası) dönülür; dosya süresine bakılmaz, ses daha uzun olabilir.
        const tolerance = Math.max(0.3, 3 / Math.max(1, Number(meta.fps) || 30));
        if (Math.abs(videoDuration - plan.duration) <= tolerance) return result;
      } catch (error) {
        if (error.cancelled || signal?.aborted) throw error;
      }
      await fsp.rm(output, { force: true }).catch(() => {});
    }
    if (options.mode === 'copy' && plan.segments && plan.segments.length > 1) {
      return await exportCopySegments(engine, input, meta, options, output, plan, { onProgress, signal });
    }
    if (options.mode === 'size') {
      return await exportVideoToSize(engine, input, meta, options, output, plan, { onProgress, signal, overlay });
    }
    const { args } = buildVideoArgs(input, meta, options, output, plan, { overlay });
    await runFfmpegProcess(engine, args, {
      duration: plan.duration,
      onProgress,
      signal,
      cwd: overlay?.dir,
    });
    return await checkVideoOutput(output);
  } finally {
    await overlay?.cleanup();
  }
}

// ── Akıllı kesim ────────────────────────────────────────────────────────
// Kayıpsız kesimde başlangıç bir anahtar kare değilse yalnızca başlangıçtan
// ilk anahtar kareye kadarki kısa bölüm (genelde 1–2 sn) kaynağa uygun
// ayarlarla yeniden kodlanır; gerisi bit bit kopyalanır. Böylece kesim hem
// kayıpsıza yakın hem de tam seçilen karede olur.

// Video akışının anahtar kareleri: yalnızca paket başlıkları okunur.
async function videoKeyframes(engine, input, from, to) {
  const { stdout } = await execFileAsync(engine.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', `${Math.max(0, from - 1).toFixed(3)}%${(to + 1).toFixed(3)}`,
    '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', input,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split(/\r?\n/)
    .filter((line) => line.includes(',K'))
    .map((line) => Number(line.split(',')[0]))
    .filter(Number.isFinite);
}

const H264_PROFILES = {
  baseline: 'baseline',
  'constrained baseline': 'baseline',
  main: 'main',
  high: 'high',
  'high 10': 'high10',
};

function knownColor(value) {
  return value && value !== 'unknown' && value !== 'reserved' ? value : null;
}

// Baştaki kısa bölümün kodlayıcısı: profil, piksel biçimi ve renk bilgisi
// kaynakla aynı; kalite görsel olarak kayıpsız düzeyde.
function smartHeadEncoderArgs(meta) {
  const fullRange = meta.pixFmt === 'yuvj420p';
  const pixFmt = fullRange ? 'yuv420p' : meta.pixFmt;
  const color = [];
  if (fullRange) color.push('-color_range', 'pc');
  if (knownColor(meta.colorPrimaries)) color.push('-color_primaries', meta.colorPrimaries);
  if (knownColor(meta.colorTransfer)) color.push('-color_trc', meta.colorTransfer);
  if (knownColor(meta.colorSpace)) color.push('-colorspace', meta.colorSpace);
  if (meta.videoCodec === 'vp9') {
    return ['-c:v', 'libvpx-vp9', '-crf', '18', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1',
      '-pix_fmt', pixFmt, ...color];
  }
  const tenBit = pixFmt === 'yuv420p10le';
  const profile = H264_PROFILES[String(meta.profile || '').toLowerCase()] || (tenBit ? 'high10' : 'high');
  const args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', pixFmt, '-profile:v', profile];
  const level = Number(meta.level);
  if (level >= 10 && level <= 62) args.push('-level:v', (level / 10).toFixed(1));
  return [...args, ...color];
}

// Bir bölümün yalnızca görüntüsü: [baş (kodlanır)] + [kuyruk (kopyalanır)].
// Parçalar iş klasörüne yazılır; dönen değer o klasördeki dosya adıdır.
async function smartCutVideo(engine, input, meta, segment, dir, tag, container, { signal, onProgress } = {}) {
  const frame = 1 / Math.max(1, Number(meta.fps) || 30);
  const keys = await videoKeyframes(engine, input, segment.start, segment.end);
  const split = shared.smartCutSplit(keys, segment.start, segment.end, frame);
  // H.264 parçaları MPEG-TS'te tutulur: orada her anahtar kare kendi
  // parametre setlerini (SPS/PPS) taşır. Baş ve kuyruk farklı kodlayıcılardan
  // geldiği için oynatıcı geçişte doğru ayarlara geçer. VP9'da böyle bir
  // sorun yok; parçalar MKV'de tutulur.
  const ext = meta.videoCodec === 'h264' ? '.ts' : '.mkv';
  const timescale = Number(String(meta.timeBase || '').split('/')[1]) || 0;
  const tsArgs = (container === 'mp4' || container === 'mov') && timescale ? ['-video_track_timescale', String(timescale)] : [];
  const inBand = meta.videoCodec === 'h264' ? ['-bsf:v', 'h264_mp4toannexb'] : [];
  const files = [];
  const total = Math.max(0.001, segment.end - segment.start);
  if (split.head) {
    const [from, to] = split.head;
    const file = `${tag}-head${ext}`;
    const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', '-noautorotate'];
    if (from > 0.001) args.push('-ss', from.toFixed(6));
    args.push('-t', (to - from).toFixed(6), '-i', input,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-fps_mode', 'passthrough',
      ...smartHeadEncoderArgs(meta), file);
    await runFfmpegProcess(engine, args, {
      cwd: dir,
      signal,
      duration: to - from,
      onProgress: (data) => onProgress?.(((Number(data.percent) || 0) / 100) * ((to - from) / total) * 0.9),
    });
    files.push(file);
  }
  if (split.tail) {
    const [from, to] = split.tail;
    const file = `${tag}-tail${ext}`;
    const args = ['-hide_banner', '-y', '-nostats'];
    // Anahtar karenin biraz sonrasına atlanır: kayan nokta yüzünden bir öncekine düşmesin.
    if (from > 0.001) args.push('-ss', (from + Math.min(0.002, frame / 4)).toFixed(6));
    args.push('-t', (to - from).toFixed(6), '-i', input,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'copy', ...inBand,
      '-avoid_negative_ts', 'make_zero', file);
    await runFfmpegProcess(engine, args, { cwd: dir, signal, duration: to - from });
    files.push(file);
  }
  onProgress?.(0.95);
  // Tek parça da olsa son kapsayıcıya aktarılır (ara parçalar TS/MKV'dir).
  const list = `${tag}-list.txt`;
  await fsp.writeFile(path.join(dir, list), files.map((file) => `file '${file}'`).join('\n'), 'utf8');
  const file = `${tag}-video.${container}`;
  await runFfmpegProcess(engine, [
    '-hide_banner', '-y', '-nostats', '-f', 'concat', '-safe', '0', '-i', list,
    '-map', '0:v', '-c', 'copy', ...tsArgs, file,
  ], { cwd: dir, signal, duration: total });
  return { file, split };
}

// Akıllı kesimle kayıpsız dışa aktarma (bir veya birden çok bölüm). Ses,
// altyazı ve üst veri kaynaktan aynı aralıkla kopyalanır.
async function exportSmartCopy(engine, input, meta, options, output, plan, { onProgress, signal } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-smart-'));
  try {
    const container = plan.container;
    const audio = pickAudioStrategy(meta, options, container, 1);
    const segments = plan.segments;
    const multi = segments.length > 1;
    const total = plan.sourceDuration;
    const rotation = Number(meta.rotation) || 0;
    let done = 0;
    const parts = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const length = segment.end - segment.start;
      const report = (fraction) => onProgress?.({ percent: ((done + fraction * length) / total) * (multi ? 95 : 100), etaSeconds: 0 });
      const { file: videoFile } = await smartCutVideo(engine, input, meta, segment, dir, `s${index}`, container, {
        signal,
        onProgress: report,
      });
      // Ses ayrı ve tam kesilir: girişte atlanınca kopyalanan ses, kesimden
      // önceki ~0,5 sn'yi gizli (eksi zamanlı) taşır; parçalar birleşince bu
      // süreye eklenip görüntüyle sesi kaydırıyordu. Çıkış tarafında atlamak
      // o paketleri gerçekten atar; giriş yine de yakın bir noktaya atlar.
      let audioFile = null;
      if (audio.enabled) {
        audioFile = `s${index}-audio.mka`;
        const preroll = Math.max(0, segment.start - 3);
        const audioArgs = ['-hide_banner', '-y', '-nostats'];
        if (preroll > 0.001) audioArgs.push('-ss', preroll.toFixed(6));
        audioArgs.push('-i', input);
        if (segment.start - preroll > 0.001) audioArgs.push('-ss', (segment.start - preroll).toFixed(6));
        audioArgs.push('-t', length.toFixed(6), '-map', '0:a', '-vn', '-sn', '-dn');
        await runFfmpegProcess(engine, [...audioArgs, ...audioEncoderArgs(audio), audioFile], { cwd: dir, signal, duration: length });
        // Ses paketleri anahtar kare diye işaretlenmemişse (bazı MKV kayıtları)
        // çıkış tarafında atlanan kopya boş kalır: o bölümün sesi kodlanır.
        if (audio.codec === 'copy' && !(await hasAudioPackets(engine, path.join(dir, audioFile)))) {
          const fallback = container === 'webm' ? { codec: 'libopus', bitrate: '256k' } : { codec: 'aac', bitrate: '320k' };
          await runFfmpegProcess(engine, [...audioArgs, ...audioEncoderArgs({ enabled: true, ...fallback }), audioFile], {
            cwd: dir, signal, duration: length,
          });
        }
      }
      const target = multi ? `part${index}${plan.ext}` : output;
      const args = ['-hide_banner', '-y', '-nostats'];
      // Baştaki bölüm döndürülmeden kodlandı; döndürme bilgisi çıktıya yeniden yazılır.
      if (rotation) args.push('-display_rotation:v:0', String(rotation));
      args.push('-i', videoFile);
      if (audioFile) args.push('-i', audioFile);
      const sourceIndex = audioFile ? 2 : 1;
      if (segment.start > 0.001) args.push('-ss', segment.start.toFixed(6));
      args.push('-t', length.toFixed(6), '-i', input, '-map', '0:v:0');
      if (audioFile) args.push('-map', '1:a');
      else args.push('-an');
      const subtitles = multi ? { indexes: [] } : pickSubtitleStrategy(meta, container);
      for (const subtitleIndex of subtitles.indexes) args.push('-map', `${sourceIndex}:s:${subtitleIndex}`);
      if (subtitles.indexes.length) {
        args.push('-c:s', subtitles.codec);
        if (container === 'mkv' && meta.attachmentCount > 0) args.push('-map', `${sourceIndex}:t?`);
      }
      // -t: kopyalanan kuyruk birkaç kare uzun kalabilir; bölüm tam süresinde biter.
      args.push('-dn', '-map_metadata', String(sourceIndex), '-map_chapters', multi ? '-1' : String(sourceIndex),
        '-c:v', 'copy', '-c:a', 'copy', '-copyinkf:a', '-t', length.toFixed(6));
      if (!multi && (container === 'mp4' || container === 'mov')) args.push('-movflags', '+faststart');
      args.push(target);
      await runFfmpegProcess(engine, args, { cwd: dir, signal, duration: length });
      parts.push(target);
      done += length;
      report(0);
    }
    if (multi) {
      await fsp.writeFile(path.join(dir, 'list.txt'), parts.map((file) => `file '${file}'`).join('\n'), 'utf8');
      const args = [
        '-hide_banner', '-y', '-progress', 'pipe:1', '-nostats',
        '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-map', '0', '-c', 'copy', '-copyinkf:a', '-map_chapters', '-1',
      ];
      if (container === 'mp4' || container === 'mov') args.push('-movflags', '+faststart');
      args.push(output);
      await runFfmpegProcess(engine, args, {
        cwd: dir,
        signal,
        duration: plan.duration,
        onProgress: (data) => onProgress?.({ ...data, percent: 95 + (Number(data.percent) || 0) * 0.05, etaSeconds: 0 }),
      });
    }
    return { ...(await checkVideoOutput(output)), smartCut: true };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function hasAudioPackets(engine, file) {
  const { stdout } = await execFileAsync(engine.ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file,
  ]).catch(() => ({ stdout: '' }));
  return Number(String(stdout).trim()) > 0;
}

// Sessiz aralıklar (silencedetect). Yalnızca ilk ses izi çözülür; görüntüye
// dokunulmaz, bu yüzden uzun videolarda da birkaç saniye sürer.
function parseSilenceLog(text, duration = 0) {
  const silences = [];
  let open = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const started = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (started) open = Math.max(0, Number(started[1]));
    const ended = line.match(/silence_end:\s*([\d.]+)/);
    if (ended && open !== null) {
      silences.push({ start: open, end: Number(ended[1]) });
      open = null;
    }
  }
  // Video sessizlikle bitiyorsa son kayıtta silence_end olmaz.
  if (open !== null && duration > open) silences.push({ start: open, end: duration });
  return silences;
}

async function detectSilences(engine, input, { from = 0, to = 0, noiseDb = -35, minSeconds = shared.SILENCE_MIN_SECONDS, signal } = {}) {
  const args = ['-hide_banner', '-nostats'];
  if (from > 0.001) args.push('-ss', from.toFixed(6));
  if (to > from) args.push('-t', (to - from).toFixed(6));
  args.push('-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', `silencedetect=noise=${Math.round(noiseDb)}dB:d=${Number(minSeconds).toFixed(2)}`, '-f', 'null', nullOutput());
  const { stderr } = await execFileAsync(engine.ffmpeg, args, { signal, maxBuffer: 64 * 1024 * 1024 });
  // -ss ile zamanlar seçimin başından sayılır; videonun zamanına çevrilir.
  return parseSilenceLog(stderr, to > from ? to - from : 0)
    .map((item) => ({ start: item.start + from, end: item.end + from }));
}

// Görüntü akışının süresi. MKV'de akış süresi DURATION etiketinde durur.
async function videoStreamDuration(engine, file) {
  const { stdout } = await execFileAsync(engine.ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration:stream_tags=DURATION', '-of', 'json', file,
  ]);
  const stream = (JSON.parse(stdout).streams || [])[0] || {};
  const direct = Number(stream.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const tag = String(stream.tags?.DURATION || '').match(/^(\d+):(\d+):([\d.]+)/);
  return tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : 0;
}

// Akıllı kesim gerekli mi: desteklenen codec ve en az bir bölüm videonun
// başından sonra başlıyor (videonun başında zaten anahtar kare vardır).
function wantsSmartCut(meta, options, plan) {
  if (options.mode !== 'copy' || options.smartCut === false) return false;
  if (!shared.smartCutSupported(meta)) return false;
  return plan.segments.some((segment) => segment.start > 0.001);
}

// Kayıpsız çok bölümlü kesim: her bölüm akış kopyasıyla ayrı bir dosyaya
// kesilir (anahtar kareye hizalı), sonra concat okuyucusuyla yeniden kodlamadan
// uç uca eklenir. İlerlemenin %95'i kesime, kalanı birleştirmeye ayrılır.
async function exportCopySegments(engine, input, meta, options, output, plan, { onProgress, signal } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-job-'));
  try {
    const total = plan.sourceDuration;
    let done = 0;
    const parts = [];
    for (let index = 0; index < plan.segments.length; index += 1) {
      const segment = plan.segments[index];
      const length = segment.end - segment.start;
      const segmentOptions = { ...options, segments: [segment], segmentPart: true };
      const segmentPlan = planVideo(meta, segmentOptions);
      const file = `part${index}${plan.ext}`;
      const { args } = buildVideoArgs(input, meta, segmentOptions, path.join(dir, file), segmentPlan);
      await runFfmpegProcess(engine, args, {
        duration: segmentPlan.duration,
        signal,
        onProgress: (data) => onProgress?.({
          ...data,
          percent: ((done + ((Number(data.percent) || 0) / 100) * length) / total) * 95,
          etaSeconds: 0,
        }),
      });
      parts.push(file);
      done += length;
    }
    await fsp.writeFile(path.join(dir, 'list.txt'), parts.map((file) => `file '${file}'`).join('\n'), 'utf8');
    const args = [
      '-hide_banner', '-y', '-progress', 'pipe:1', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-map', '0', '-c', 'copy', '-map_chapters', '-1',
    ];
    if (plan.container === 'mp4' || plan.container === 'mov') args.push('-movflags', '+faststart');
    args.push(output);
    await runFfmpegProcess(engine, args, {
      cwd: dir,
      signal,
      duration: plan.duration,
      onProgress: (data) => onProgress?.({ ...data, percent: 95 + (Number(data.percent) || 0) * 0.05, etaSeconds: 0 }),
    });
    return await checkVideoOutput(output);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Videoları birleştirme ───────────────────────────────────────────────
// Uyumlu videolar (aynı codec/çözünürlük/kare hızı/ses) concat okuyucusuyla
// yeniden kodlanmadan eklenir. Değilse hepsi ilk videonun boyutuna ve kare
// hızına getirilir (oran korunur, boşluk siyahla doldurulur), ses ortak
// biçime çevrilir ve tek seferde kodlanır.
function planMerge(metas, settings = {}) {
  if (!Array.isArray(metas) || metas.length < 2) throw new Error('Birleştirmek için en az iki video ekleyin.');
  const compat = shared.mergeCompatibility(metas);
  const lossless = settings.mode !== 'reencode' && compat.compatible;
  const first = metas[0];
  const codec = ['h264', 'h265', 'vp9'].includes(settings.codec) ? settings.codec : 'h264';
  const container = lossless ? copyContainer(first) : codecContainer(codec);
  const even = (value) => Math.max(2, Math.floor((Number(value) || 2) / 2) * 2);
  return {
    lossless,
    compat,
    codec,
    container,
    ext: `.${container}`,
    duration: metas.reduce((sum, meta) => sum + (Number(meta.duration) || 0), 0),
    width: even(first.width),
    height: even(first.height),
    fps: Number(first.fps) > 0 ? Number(Number(first.fps).toFixed(6)) : 30,
    hasAudio: settings.audioMode !== 'none' && metas.some((meta) => meta.hasAudio),
    // 10-bit yalnızca tüm kaynaklar derin renkliyse ve codec destekliyorsa korunur.
    tenBit: metas.every((meta) => meta.bitDepth > 8),
  };
}

function concatListLine(file) {
  // concat listesinde yol tek tırnak içinde; tırnak '\'' ile kaçırılır.
  return `file '${path.resolve(file).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

function buildMergeArgs(inputs, metas, settings, plan, output, hwVendor = null) {
  const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
  for (const input of inputs) args.push('-i', input);
  const { width: W, height: H, fps } = plan;
  const tenBit = plan.tenBit && plan.codec !== 'h264';
  const graph = [];
  const concatInputs = [];
  metas.forEach((meta, index) => {
    graph.push(`[${index}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=${tenBit ? 'yuv420p10le' : 'yuv420p'},setpts=PTS-STARTPTS[v${index}]`);
    concatInputs.push(`[v${index}]`);
    if (plan.hasAudio) {
      graph.push(meta.hasAudio
        ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`
        // Sessiz videoya, süresi kadar sessizlik eklenir ki ses kaymasın.
        : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${(Number(meta.duration) || 0).toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`);
      concatInputs.push(`[a${index}]`);
    }
  });
  graph.push(`${concatInputs.join('')}concat=n=${metas.length}:v=1:a=${plan.hasAudio ? 1 : 0}[vout]${plan.hasAudio ? '[aout]' : ''}`);
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (plan.hasAudio) {
    args.push('-map', '[aout]');
    if (plan.container === 'webm') args.push('-c:a', 'libopus', '-b:a', '256k');
    else args.push('-c:a', 'aac', '-b:a', '320k');
  } else {
    args.push('-an');
  }
  args.push('-sn', '-dn', '-map_metadata', '0', '-map_chapters', '-1');
  args.push(...videoEncoderArgs({
    codec: plan.codec,
    preset: ['fast', 'medium', 'slow'].includes(settings.preset) ? settings.preset : 'medium',
    crf: clamp(Number(settings.crf) || 18, 0, 51),
    tenBit,
    hwVendor,
    mode: 'crf',
  }));
  if (plan.container === 'mp4' || plan.container === 'mov') args.push('-movflags', '+faststart');
  args.push(output);
  return args;
}

async function exportMerge(engine, inputs, metas, settings, outputPath, { onProgress, signal, hwVendor = null } = {}) {
  const output = path.resolve(outputPath);
  const plan = planMerge(metas, settings);
  if (!plan.lossless) {
    await runFfmpegProcess(engine, buildMergeArgs(inputs.map((file) => path.resolve(file)), metas, settings, plan, output, hwVendor), {
      duration: plan.duration,
      onProgress,
      signal,
    });
    return { ...(await checkVideoOutput(output)), plan };
  }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'odak-job-'));
  try {
    await fsp.writeFile(path.join(dir, 'list.txt'), inputs.map(concatListLine).join('\n'), 'utf8');
    const args = [
      '-hide_banner', '-y', '-progress', 'pipe:1', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-map', '0:v',
    ];
    if (plan.hasAudio) args.push('-map', '0:a?');
    else args.push('-an');
    args.push('-sn', '-dn', '-c', 'copy', '-copyinkf:a', '-map_chapters', '-1');
    if (plan.container === 'mp4' || plan.container === 'mov') args.push('-movflags', '+faststart');
    args.push(output);
    await runFfmpegProcess(engine, args, { cwd: dir, duration: plan.duration, onProgress, signal });
    return { ...(await checkVideoOutput(output)), plan };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkVideoOutput(tempPath) {
  if (!(await exists(tempPath))) throw new Error('Çıktı dosyası oluşmadı.');
  const stat = await fsp.stat(tempPath);
  if (stat.size < 100) throw new Error('Çıktı dosyası boş görünüyor.');
  return { size: stat.size };
}

// Hedef boyut: 1. geçiş videoyu analiz eder, 2. geçiş bütçeye göre kodlar.
// Sonuç hedefi yine de aşarsa (çoğunlukla VP9) 2. geçiş, aşım oranı kadar
// düşürülmüş bit hızıyla bir kez daha yapılır; analiz kaydı yeniden kullanılır.
async function exportVideoToSize(engine, input, meta, options, tempPath, plan, { onProgress, signal, overlay } = {}) {
  const passLogFile = path.join(os.tmpdir(), `odak-pass-${crypto.randomUUID()}`);
  const stage = (pass, from, span) => (data) => {
    if (!onProgress) return;
    onProgress({ ...data, pass, percent: from + (Number(data.percent) || 0) * span, etaSeconds: 0 });
  };
  const cwd = overlay?.dir;
  // GPU kodlayıcı tek geçişte kendi çok geçişli moduyla çalışır.
  const twoPass = !HW_ENCODERS[options.hwVendor];
  try {
    if (twoPass) {
      const first = buildVideoArgs(input, meta, options, tempPath, plan, { pass: 1, passLogFile, overlay });
      await runFfmpegProcess(engine, first.args, { duration: plan.duration, onProgress: stage(1, 0, 0.45), signal, cwd });
    }

    const second = buildVideoArgs(input, meta, options, tempPath, plan, { pass: 2, passLogFile, overlay });
    await runFfmpegProcess(engine, second.args, {
      duration: plan.duration,
      onProgress: twoPass ? stage(2, 45, 0.55) : stage(0, 0, 1),
      signal,
      cwd,
    });
    let result = await checkVideoOutput(tempPath);
    let videoKbps = second.size.videoKbps;
    let retried = false;

    if (result.size > second.size.targetBytes) {
      const audioBudget = second.size.audioKbps * sizeAudioTrackCount(meta, options);
      const overshoot = second.size.targetBytes / result.size;
      videoKbps = Math.floor((videoKbps + audioBudget) * overshoot * 0.97 - audioBudget);
      if (videoKbps < shared.SIZE_MIN_VIDEO_KBPS) {
        throw new Error('Video hedef boyuta sığdırılamadı. Daha büyük bir hedef seçin veya videoyu kısaltın.');
      }
      const retry = buildVideoArgs(input, meta, options, tempPath, plan, { pass: 2, passLogFile, videoKbps, overlay });
      await runFfmpegProcess(engine, retry.args, { duration: plan.duration, onProgress: stage(3, 45, 0.55), signal, cwd });
      result = await checkVideoOutput(tempPath);
      retried = true;
    }
    return {
      ...result,
      targetBytes: second.size.targetBytes,
      videoKbps,
      audioKbps: second.size.audioKbps,
      retried,
      overTarget: result.size > second.size.targetBytes,
    };
  } finally {
    await removePassLogs(passLogFile);
  }
}

async function removePassLogs(prefix) {
  const dir = path.dirname(prefix);
  const base = path.basename(prefix);
  try {
    for (const name of await fsp.readdir(dir)) {
      if (name.startsWith(base)) await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  } catch {
    // Geçici kayıtlar en kötü ihtimalle sistem temp klasöründe kalır.
  }
}

async function saveFrame(engine, sourcePath, meta, time, outputPath, options = {}) {
  const input = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  const seconds = Math.max(0, Number(time) || 0);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', seconds.toFixed(6),
    '-i', input,
  ];
  // Kaydedilen kare, ekrandaki gibi metin ve yakılan altyazıyı da içerir.
  const overlay = await prepareOverlays(engine, input, meta, options, geometryOutputSize(meta, options, { evenSize: false }));
  try {
    const filters = buildFrameFilters(options, overlayFilters(overlay, seconds));
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-frames:v', '1', '-map', '0:v:0', '-an', '-sn');
    if (meta.bitDepth > 8) args.push('-pix_fmt', 'rgb48be');
    args.push(output);
    await runFfmpegProcess(engine, args, { cwd: overlay?.dir });
  } finally {
    await overlay?.cleanup();
  }
  if (!(await exists(output))) throw new Error('Kare kaydedilemedi.');
  const stat = await fsp.stat(output);
  if (!stat.size) throw new Error('Kare kaydedilemedi: boş dosya oluştu.');
  return { size: stat.size };
}

module.exports = {
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  isVideoPath,
  isImagePath,
  pixelBitDepth,
  detectEngine,
  probeMedia,
  probeVideo,
  probeImage,
  buildFilmstripArgs,
  makeFilmstrip,
  makePoster,
  planVideo,
  planMerge,
  buildMergeArgs,
  exportMerge,
  normalizeSegments,
  videoEncoderArgs,
  isCopyAllowed,
  buildVideoFilters,
  buildFrameFilters,
  buildVideoArgs,
  hardwareVideoArgs,
  detectHardwareEncoders,
  resolveHardwareVendor,
  geometryOutputSize,
  prepareOverlays,
  overlayFilters,
  planSizeMode,
  sizeFitsAsCopy,
  videoKeyframes,
  parseSilenceLog,
  detectSilences,
  smartHeadEncoderArgs,
  wantsSmartCut,
  exportSmartCopy,
  pickSubtitleStrategy,
  exportVideo,
  saveFrame,
  runFfmpegProcess,
  copyContainer,
};
