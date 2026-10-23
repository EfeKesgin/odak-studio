'use strict';
// Odak Studio - saf video filtre/planlama testleri (FFmpeg calistirmaz)
const assert = require('node:assert');
const media = require('../electron/media.js');

const EVEN_CROP = 'crop=trunc(iw/2)*2:trunc(ih/2)*2';

// 1) Degisiklik yok: sadece cift boyut korumasi
assert.deepStrictEqual(
  media.buildVideoFilters({ rotation: 0, flipH: false, flipV: false, crop: null, resize: null, speed: 1 }),
  [EVEN_CROP],
);

// 2) Tam zincir: donus -> cevirme -> kirpma -> olcekleme -> hiz -> cift boyut
assert.deepStrictEqual(
  media.buildVideoFilters({
    rotation: 90, flipH: true, flipV: true,
    crop: { x: 10, y: 20, width: 100, height: 50 },
    resize: { width: 640, height: 360 }, speed: 2,
  }),
  ['transpose=1', 'hflip', 'vflip', 'crop=100:50:10:20', 'scale=640:360:flags=lanczos',
    'setpts=PTS/2', EVEN_CROP],
);

// 3) Donus normalizasyonu
assert.deepStrictEqual(media.buildVideoFilters({ rotation: 270 }).slice(0, 1), ['transpose=2']);
assert.deepStrictEqual(media.buildVideoFilters({ rotation: -90 }).slice(0, 1), ['transpose=2']);
assert.deepStrictEqual(media.buildVideoFilters({ rotation: 180 }).slice(0, 2), ['hflip', 'vflip']);
assert.deepStrictEqual(media.buildVideoFilters({ rotation: 360 }).slice(0, 1), [EVEN_CROP]);
assert.deepStrictEqual(media.buildVideoFilters({ rotation: 450 }).slice(0, 1), ['transpose=1']);

// 4) Kirpma degerleri sayisal ve en az 2 px
assert.deepStrictEqual(
  media.buildVideoFilters({ crop: { x: '5.4', y: '7.6', width: '101.5', height: '1' } }).slice(0, 1),
  ['crop=102:2:5:8'],
);

// 5) Kare filtreleri: hiz ve cift boyut zorlamasi yok, tek boyut korunur
assert.deepStrictEqual(media.buildFrameFilters({}), []);
assert.deepStrictEqual(
  media.buildFrameFilters({ rotation: 90, crop: { x: 1, y: 3, width: 101, height: 51 }, speed: 2 }),
  ['transpose=1', 'crop=101:51:1:3'],
);
assert.deepStrictEqual(
  media.buildFrameFilters({ resize: { width: 333, height: 777 } }),
  ['scale=333:777:flags=lanczos'],
);

// 6) Kopya modu uygunlugu
assert.strictEqual(media.isCopyAllowed({ speed: 1 }), true);
assert.strictEqual(media.isCopyAllowed({ speed: 1.00001 }), true);
assert.strictEqual(media.isCopyAllowed({ speed: 1.5 }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, rotation: 90 }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, flipH: true }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, flipV: true }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, crop: { width: 10, height: 10 } }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, resize: { width: 10, height: 10 } }), false);

// 7) Kopya kapsayicisi
assert.strictEqual(media.copyContainer({ ext: 'mp4' }), 'mp4');
assert.strictEqual(media.copyContainer({ ext: 'm4v' }), 'mp4');
assert.strictEqual(media.copyContainer({ ext: 'mov' }), 'mov');
assert.strictEqual(media.copyContainer({ ext: 'webm' }), 'webm');
assert.strictEqual(media.copyContainer({ ext: 'mkv' }), 'mkv');
assert.strictEqual(media.copyContainer({ ext: 'avi' }), 'mkv');

// 8) Kapsayici secimi
assert.strictEqual(media.planVideo({ ext: 'mp4', duration: 10 }, { mode: 'copy' }).ext, '.mp4');
assert.strictEqual(media.planVideo({ ext: 'webm', duration: 10 }, { mode: 'copy', audioMode: 'aac' }).ext, '.mkv');
assert.strictEqual(media.planVideo({ ext: 'mp4', duration: 10 }, { mode: 'crf', codec: 'vp9' }).ext, '.webm');
assert.strictEqual(media.planVideo({ ext: 'mp4', duration: 10 }, { mode: 'crf', codec: 'prores' }).ext, '.mov');
// Suresi 2x hizda yariya iner
const plan = media.planVideo({ ext: 'mp4', duration: 20 }, { mode: 'crf', trimStart: 4, trimEnd: 14, speed: 2 });
assert.strictEqual(plan.sourceDuration, 10);
assert.strictEqual(plan.duration, 5);

// 9) FFmpeg argumanlari (calistirmadan)
const meta10 = {
  duration: 20, hasAudio: true, audioCodec: 'aac', bitDepth: 10, isHdr: true,
  colorTransfer: 'smpte2084', colorPrimaries: 'bt2020',
  videoBitrate: 12000000, overallBitrate: 13000000, audioBitrate: 192000,
  width: 3840, height: 2160, ext: 'mp4',
};
const meta8 = { ...meta10, bitDepth: 8, isHdr: false };
const build = (meta, options, input = 'in.mp4') => {
  const p = media.planVideo(meta, options);
  return media.buildVideoArgs(input, meta, options, 'out.tmp', p).args;
};
const has = (args, ...values) => values.every((v) => args.includes(v));
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

// a) Kopya modu: kesim + ses kopyasi + faststart
const copyArgs = build(meta8, { mode: 'copy', trimStart: 2, trimEnd: 12, speed: 1, audioMode: 'original' });
assert.ok(has(copyArgs, '-c:v', 'copy', '-c:a', 'copy', '-avoid_negative_ts', 'make_zero', '+faststart'));
assert.strictEqual(valueOf(copyArgs, '-ss'), '2.000000');
assert.strictEqual(valueOf(copyArgs, '-t'), '10.000000');
assert.ok(!copyArgs.includes('-vf'));

// b) 8-bit H.265 CRF, sessiz
const h265Args = build(meta8, { mode: 'crf', codec: 'h265', audioMode: 'none', speed: 1, crf: 16, preset: 'medium' });
assert.ok(has(h265Args, '-c:v', 'libx265', '-preset', 'medium', '-crf', '16',
  '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-tag:v', 'hvc1', '-an'));
assert.ok(!h265Args.includes('-c:a'));

// c) 2x hiz + ses: atempo ve AAC 320k
const speedArgs = build(meta8, { mode: 'crf', codec: 'h264', audioMode: 'original', speed: 2, crf: 16 });
assert.ok(has(speedArgs, '-af', 'atempo=2.0000', '-c:a', 'aac', '-b:a', '320k'));
assert.strictEqual(valueOf(speedArgs, '-vf'), 'setpts=PTS/2,' + EVEN_CROP);

// d) 10-bit HDR H.265: main10 + BT.2020/PQ etiketleri
const hdrArgs = build(meta10, { mode: 'crf', codec: 'h265', audioMode: 'original', speed: 1, crf: 16 });
assert.ok(has(hdrArgs, '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10',
  '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020'));
// ses zaten uyumlu oldugu icin kopyalanir
assert.ok(has(hdrArgs, '-c:a', 'copy'));
// HDR etiketleri H.264 secildiginde de korunmali
const hdr264Args = build(meta10, { mode: 'crf', codec: 'h264', audioMode: 'none', speed: 1, crf: 16 });
assert.ok(has(hdr264Args, '-pix_fmt', 'yuv420p10le', '-profile:v', 'high10',
  '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020'));
// HLG kaynagi HLG olarak etiketlenir
const hlgArgs = build({ ...meta10, colorTransfer: 'arib-std-b67' },
  { mode: 'crf', codec: 'h265', audioMode: 'none', speed: 1 });
assert.ok(has(hlgArgs, '-color_trc', 'arib-std-b67'));

// e) Bit hizi modu CRF gondermemeli (x264/x265 cakismasi)
const bitrateArgs = build(meta8, { mode: 'bitrate', codec: 'h264', audioMode: 'original', speed: 1, bitrateKbps: 8000 });
assert.ok(has(bitrateArgs, '-b:v', '8000k', '-maxrate', '12000k', '-bufsize', '16000k'));
assert.ok(!bitrateArgs.includes('-crf'));

// f) VP9 bit hizi modu
const vp9Args = build(meta8, { mode: 'bitrate', codec: 'vp9', audioMode: 'none', speed: 1, bitrateKbps: 5000 });
assert.ok(has(vp9Args, '-c:v', 'libvpx-vp9', '-row-mt', '1', '-b:v', '5000k'));
assert.ok(!vp9Args.includes('-crf'));
assert.strictEqual(vp9Args.filter((v) => v === '-b:v').length, 1);

// g) ProRes + AAC istegi -> PCM ses
const proresArgs = build(meta8, { mode: 'crf', codec: 'prores', audioMode: 'aac', speed: 1 });
assert.ok(has(proresArgs, '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
  '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s24le'));

// h) ProRes + uyumsuz ses kodegi (opus) + orijinal -> PCM
const opusMeta = { ...meta8, ext: 'mkv', audioCodec: 'opus', audioBitrate: 128000 };
const proresOpus = build(opusMeta, { mode: 'crf', codec: 'prores', audioMode: 'original', speed: 1 });
assert.ok(has(proresOpus, '-c:a', 'pcm_s24le'));

// i) ProRes + AAC kaynak + orijinal -> ses kopyalanir
const proresAac = build(meta8, { mode: 'crf', codec: 'prores', audioMode: 'original', speed: 1 });
assert.ok(has(proresAac, '-c:a', 'copy'));

// j) Kopya modunda MOV + AAC istegi -> AAC (PCM'e cevrilmemeli)
const copyMovAac = build({ ...meta8, ext: 'mov' },
  { mode: 'copy', codec: 'prores', audioMode: 'aac', speed: 1, trimStart: 0, trimEnd: 10 });
assert.ok(has(copyMovAac, '-c:a', 'aac', '-b:a', '320k'));
assert.ok(!copyMovAac.includes('pcm_s24le'));

// k) VP9/WebM + AAC istegi -> Opus 256k
const vp9Aac = build(meta8, { mode: 'crf', codec: 'vp9', audioMode: 'aac', speed: 1 });
assert.ok(has(vp9Aac, '-c:a', 'libopus', '-b:a', '256k'));

// l) Gorsel degisiklik varken kopya modu reddedilir
assert.throws(
  () => build(meta8, { mode: 'copy', crop: { x: 0, y: 0, width: 100, height: 100 }, speed: 1 }),
  /kopyalama/,
);

// m) -t giris secenegi olmali; hiz degisiminde trim sonu asilmamali
const trimSpeedArgs = build(meta8,
  { mode: 'crf', codec: 'h264', audioMode: 'none', speed: 2, trimStart: 1, trimEnd: 5, crf: 16 });
const tIndex = trimSpeedArgs.indexOf('-t');
const iIndex = trimSpeedArgs.indexOf('-i');
assert.ok(tIndex > -1 && tIndex < iIndex, '-t must be an input option (before -i)');
assert.strictEqual(trimSpeedArgs[tIndex + 1], '4.000000');
assert.ok(trimSpeedArgs.some((arg) => String(arg).includes('setpts=PTS/2')));

// n) Tum ses izleri ve tasinabilen altyazilar korunur
const multiMeta = {
  ...meta8, ext: 'mkv',
  audioTracks: [{ codec: 'aac', language: 'tur' }, { codec: 'opus', language: 'eng' }],
  subtitleTracks: [{ codec: 'subrip' }, { codec: 'ass' }, { codec: 'hdmv_pgs_subtitle' }],
  attachmentCount: 1,
};
const mkvCopy = build(multiMeta, { mode: 'copy', audioMode: 'original', speed: 1 }, 'in.mkv');
assert.ok(has(mkvCopy, '-map', '0:a?', '0:s:0', '0:s:1', '0:s:2', '0:t?'));
assert.strictEqual(valueOf(mkvCopy, '-c:s'), 'copy');
assert.ok(!mkvCopy.includes('-sn'));
assert.ok(!mkvCopy.includes('0:a:0?'), 'yalnizca ilk ses izi alinmamali');
// MP4: metin altyazilar mov_text olur, resim altyazi (PGS) atlanir;
// izlerden biri MP4'e uymadigi (opus) icin tum sesler AAC'ye cevrilir.
const mp4Multi = build(multiMeta, { mode: 'crf', codec: 'h264', audioMode: 'original', speed: 1 }, 'in.mkv');
assert.ok(has(mp4Multi, '0:s:0', '0:s:1', '-c:a', 'aac'));
assert.ok(!mp4Multi.includes('0:s:2'));
assert.ok(!mp4Multi.includes('0:t?'));
assert.strictEqual(valueOf(mp4Multi, '-c:s'), 'mov_text');
// WebM: metin altyazilar WebVTT olur
assert.strictEqual(valueOf(build(multiMeta, { mode: 'crf', codec: 'vp9', audioMode: 'none', speed: 1 }, 'in.mkv'), '-c:s'), 'webvtt');
// Altyazi yoksa -sn, ses yoksa -an
const plainArgs = build(meta8, { mode: 'crf', codec: 'h264', audioMode: 'none', speed: 1 });
assert.ok(has(plainArgs, '-sn', '-an'));
assert.deepStrictEqual(media.pickSubtitleStrategy({ subtitleTracks: [{ codec: 'dvd_subtitle' }] }, 'mp4'),
  { indexes: [], codec: 'mov_text', skipped: 1 });

// o) Film seridi: her kare icin ayri hizli atlama, sonda yan yana dizilir
const stripArgs = media.buildFilmstripArgs('in.mp4', 120, 'film.jpg');
const seeks = stripArgs.filter((arg, index) => stripArgs[index - 1] === '-ss').map(Number);
assert.strictEqual(seeks.length, 12);
assert.strictEqual(seeks[0], 5);
assert.strictEqual(seeks[11], 115);
assert.ok(seeks.every((time) => time < 120), 'son kareye atlanmamali');
assert.ok(valueOf(stripArgs, '-filter_complex').endsWith('hstack=inputs=12'));
assert.strictEqual(valueOf(stripArgs, '-frames:v'), '1');
assert.strictEqual(stripArgs.filter((arg) => arg === '-i').length, 12);

// p) Hiz degisince kare hizi filtre icinde kaynaga indirilir (iki gecisli
// kodlamada bit hizi hesabinin tutmasi icin)
assert.deepStrictEqual(media.buildVideoFilters({ speed: 2 }, { fps: 30 }).slice(0, 2), ['setpts=PTS/2', 'fps=30']);
assert.deepStrictEqual(media.buildVideoFilters({ speed: 1 }, { fps: 30 }), [EVEN_CROP]);

// q) Hedef dosya boyutu: iki gecis, butce hesabi ve hatalar
const shared = require('../src/shared.js');
const rates = shared.sizeModeBitrates({ targetMB: 10, duration: 60, codec: 'h264', audioTracks: 1 });
assert.strictEqual(rates.targetBytes, 10e6);
assert.strictEqual(rates.audioKbps, 128);
assert.strictEqual(rates.videoKbps, Math.floor((10e6 * 8 * 0.96) / 60 / 1000 - 128));
assert.ok(rates.feasible);
const vp9Rates = shared.sizeModeBitrates({ targetMB: 10, duration: 60, codec: 'vp9', audioTracks: 0 });
assert.ok(vp9Rates.videoKbps < rates.videoKbps + 128, 'VP9 daha genis pay birakir');
assert.strictEqual(vp9Rates.audioKbps, 0);
const tiny = shared.sizeModeBitrates({ targetMB: 0.05, duration: 60, audioTracks: 1 });
assert.strictEqual(tiny.feasible, false);
assert.ok(tiny.minMB > 0.05);
// Iki ses izi varsa butceden ikisi de duser
const twoTracks = shared.sizeModeBitrates({ targetMB: 10, duration: 60, audioTracks: 2 });
assert.strictEqual(twoTracks.videoKbps, rates.videoKbps - 128);
// Hedef ust sinirdir: kisa ve dusuk bit hizli kaynak sisirilmez
const shortClip = shared.sizeModeBitrates({ targetMB: 9.5, duration: 4, audioTracks: 1, sourceVideoKbps: 3100 });
assert.strictEqual(shortClip.videoKbps, 3100);
assert.ok(shortClip.capped && shortClip.feasible);
const longClip = shared.sizeModeBitrates({ targetMB: 10, duration: 60, audioTracks: 1, sourceVideoKbps: 20000 });
assert.strictEqual(longClip.videoKbps, rates.videoKbps);
assert.strictEqual(longClip.capped, false);

const sizeOptions = { mode: 'size', codec: 'h264', audioMode: 'original', speed: 1, targetMB: 10, trimStart: 0, trimEnd: 20 };
const sizePlan = media.planVideo(meta8, sizeOptions);
const pass1 = media.buildVideoArgs('in.mp4', meta8, sizeOptions, 'out.tmp', sizePlan, { pass: 1, passLogFile: 'log' }).args;
assert.ok(has(pass1, '-pass', '1', '-passlogfile', 'log', '-an', '-f', 'null'));
assert.ok(!pass1.includes('out.tmp'), 'analiz gecisi dosya yazmaz');
assert.ok(!pass1.includes('-c:a'));
const pass2Built = media.buildVideoArgs('in.mp4', meta8, sizeOptions, 'out.tmp', sizePlan, { pass: 2, passLogFile: 'log' });
const pass2 = pass2Built.args;
assert.ok(has(pass2, '-pass', '2', '-c:a', 'aac', 'out.tmp'));
assert.strictEqual(valueOf(pass2, '-b:v'), `${pass2Built.size.videoKbps}k`);
assert.strictEqual(valueOf(pass2, '-b:a'), `${pass2Built.size.audioKbps}k`);
assert.ok(!pass2.includes('-crf') && !pass2.includes('-maxrate'), 'iki gecis ortalama bit hizi kullanir');
// Yeniden deneme bit hizi butcenin yerine gecer
const retryArgs = media.buildVideoArgs('in.mp4', meta8, sizeOptions, 'out.tmp', sizePlan, { pass: 2, passLogFile: 'log', videoKbps: 1234 }).args;
assert.strictEqual(valueOf(retryArgs, '-b:v'), '1234k');
// WebM'de ses Opus olur
const vp9Size = build(meta8, { ...sizeOptions, codec: 'vp9' });
assert.ok(has(vp9Size, '-c:a', 'libopus', '-pass', '2'));
assert.throws(() => build(meta8, { ...sizeOptions, codec: 'prores' }), /ProRes/);
assert.throws(() => build(meta8, { ...sizeOptions, targetMB: 0.01 }), /çok küçük/);
assert.throws(() => build(meta8, { ...sizeOptions, targetMB: 0 }), /hedef dosya boyutu/);

// r) Metin katmanlari ve altyazi yakma
const layer = shared.cleanTextLayer({ text: 'A{b}\\c\nİkinci', size: 10, color: '#FF8800', x: 0.25, y: 0.75, start: 2, end: 5, style: 'box', bold: true });
assert.strictEqual(layer.color, '#ff8800');
const ass = shared.buildAssDocument({ width: 1280, height: 720, layers: [layer, { text: '   ' }] });
assert.ok(ass.includes('PlayResX: 1280') && ass.includes('PlayResY: 720'));
assert.ok(ass.includes('{\\pos(320.0,540.0)}A｛b｝⧵c\\Nİkinci'), 'ozel karakterler kacirilir, satir sonu \\N olur');
assert.ok(ass.includes('Dialogue: 0,0:00:02.00,0:00:05.00,L0'), 'zamanlama');
assert.strictEqual((ass.match(/^Dialogue:/gm) || []).length, 1, 'bos metin atlanir');
assert.ok(ass.includes(`,${shared.assColor('#ff8800')},`), 'renk ASS sirasinda (BGR)');
assert.strictEqual(shared.assColor('#ff8800'), '&H000088FF');
assert.strictEqual(shared.assColor('#000000', 1), '&HFF000000');
assert.ok(/,-1,0,0,0,100,100,0,0,3,/.test(ass), 'kalin + kutu stili (BorderStyle 3)');
assert.strictEqual(shared.cleanTextLayer({ size: 99, x: 3, y: -1, font: 'Yok', style: 'x', end: 1, start: 4 }).size, 30);
assert.deepStrictEqual(
  (({ x, y, font, style, end }) => ({ x, y, font, style, end }))(shared.cleanTextLayer({ x: 3, y: -1, font: 'Yok', style: 'x', end: 1, start: 4 })),
  { x: 1, y: 0, font: 'Arial', style: 'outline', end: null },
);
assert.strictEqual(shared.cleanTextLayers(new Array(20).fill({ text: 'a' })).length, shared.MAX_TEXT_LAYERS);

assert.strictEqual(media.isCopyAllowed({ speed: 1, textLayers: [{ text: 'a' }] }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, textLayers: [{ text: '  ' }] }), true, 'bos metin kopyayi engellemez');
assert.strictEqual(media.isCopyAllowed({ speed: 1, burnSubtitle: 0 }), false);
assert.strictEqual(media.isCopyAllowed({ speed: 1, burnSubtitle: -1 }), true);
assert.deepStrictEqual(media.geometryOutputSize({ width: 1921, height: 1080 }, { rotation: 90 }), { width: 1080, height: 1920 });
assert.deepStrictEqual(media.geometryOutputSize({ width: 1920, height: 1080 }, { crop: { width: 801, height: 601 } }, { evenSize: false }), { width: 801, height: 601 });
assert.deepStrictEqual(media.geometryOutputSize({ width: 1920, height: 1080 }, { crop: { width: 801, height: 601 }, resize: { width: 400, height: 300 } }), { width: 400, height: 300 });
const overlay = { filters: ['subtitles=subs.ass', 'subtitles=text.ass'] };
assert.deepStrictEqual(media.overlayFilters(overlay, 0), ['subtitles=subs.ass', 'subtitles=text.ass']);
assert.deepStrictEqual(media.overlayFilters(overlay, 12.5), ['setpts=PTS+12.500000/TB', 'subtitles=subs.ass', 'subtitles=text.ass', 'setpts=PTS-STARTPTS']);
assert.deepStrictEqual(media.overlayFilters(null, 5), []);
// Metin geometriden sonra, hizdan once cizilir
const textArgs = media.buildVideoArgs('in.mp4', meta8, { mode: 'crf', codec: 'h264', speed: 2, trimStart: 3, trimEnd: 8, rotation: 90, audioMode: 'none' }, 'out.tmp',
  media.planVideo(meta8, { mode: 'crf', trimStart: 3, trimEnd: 8, speed: 2 }), { overlay: { filters: ['subtitles=text.ass'] } }).args;
const vf = valueOf(textArgs, '-vf').split(',');
assert.ok(vf.indexOf('transpose=1') < vf.indexOf('subtitles=text.ass'));
assert.ok(vf.indexOf('subtitles=text.ass') < vf.indexOf('setpts=PTS/2'));
assert.strictEqual(vf[vf.indexOf('subtitles=text.ass') - 1], 'setpts=PTS+3.000000/TB');
// Yakilan iz ayrica yumusak altyazi olarak eklenmez
const burnArgs = build(multiMeta, { mode: 'crf', codec: 'h264', audioMode: 'none', speed: 1, burnSubtitle: 0 }, 'in.mkv');
assert.ok(!burnArgs.includes('0:s:0') && burnArgs.includes('0:s:1'));

// s) Donanim (GPU) kodlama
const hardware = { h264: ['nvenc'], h265: ['qsv', 'nvenc'] };
assert.strictEqual(media.resolveHardwareVendor({ encoder: 'gpu', codec: 'h265', mode: 'crf' }, hardware), 'qsv');
assert.strictEqual(media.resolveHardwareVendor({ encoder: 'cpu', codec: 'h264', mode: 'crf' }, hardware), null);
assert.strictEqual(media.resolveHardwareVendor({ encoder: 'gpu', codec: 'vp9', mode: 'crf' }, hardware), null, 'VP9 GPU yok');
assert.strictEqual(media.resolveHardwareVendor({ encoder: 'gpu', codec: 'h264', mode: 'copy' }, hardware), null);
assert.strictEqual(media.resolveHardwareVendor({ encoder: 'gpu', codec: 'h264', mode: 'crf' }, null), null);
const nvCrf = media.hardwareVideoArgs('nvenc', 'h264', { mode: 'crf', crf: 18, preset: 'slow' });
assert.ok(has(nvCrf, '-c:v', 'h264_nvenc', '-preset', 'p7', '-cq', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high'));
const nvSize = media.hardwareVideoArgs('nvenc', 'h265', { mode: 'size', bitrateKbps: 2000, tenBit: true });
assert.ok(has(nvSize, '-c:v', 'hevc_nvenc', '-b:v', '2000k', '-multipass', 'fullres', '-pix_fmt', 'p010le', '-profile:v', 'main10', '-tag:v', 'hvc1'));
assert.ok(!nvSize.includes('-cq'));
// H.264 donanimda 10-bit kaynak 8-bit kodlanir
assert.ok(has(media.hardwareVideoArgs('nvenc', 'h264', { tenBit: true }), '-pix_fmt', 'yuv420p'));
assert.ok(has(media.hardwareVideoArgs('qsv', 'h264', { crf: 20 }), '-c:v', 'h264_qsv', '-global_quality', '20', '-pix_fmt', 'nv12'));
assert.ok(has(media.hardwareVideoArgs('amf', 'h265', { mode: 'bitrate', bitrateKbps: 5000 }), '-c:v', 'hevc_amf', '-rc', 'vbr_peak', '-b:v', '5000k'));
assert.throws(() => media.hardwareVideoArgs('nvenc', 'vp9'), /donanım/);
const gpuArgs = build(meta8, { mode: 'crf', codec: 'h264', crf: 20, speed: 1, audioMode: 'none', hwVendor: 'nvenc' });
assert.ok(has(gpuArgs, 'h264_nvenc', '-cq', '20') && !gpuArgs.includes('libx264') && !gpuArgs.includes('-crf'));
// Hedef boyut GPU'da tek gecis: -pass/-passlogfile yok
const gpuSize = media.buildVideoArgs('in.mp4', meta8, { ...sizeOptions, hwVendor: 'nvenc' }, 'out.tmp', sizePlan, { pass: 1, passLogFile: 'log' }).args;
assert.ok(!gpuSize.includes('-pass') && gpuSize.includes('out.tmp') && gpuSize.includes('fullres'));
// Bilinmeyen uretici yok sayilir, islemciye donulur
assert.ok(build(meta8, { mode: 'crf', codec: 'h264', speed: 1, audioMode: 'none', hwVendor: 'evil' }).includes('libx264'));

// t) Cok bolumlu kesim
assert.deepStrictEqual(
  media.normalizeSegments({ segments: [{ start: 6, end: 8 }, { start: 1, end: 3 }, { start: 2.5, end: 4 }, { start: 9, end: 9.01 }, { start: 15, end: 30 }] }, 20),
  [{ start: 1, end: 4 }, { start: 6, end: 8 }, { start: 15, end: 20 }],
  'siralanir, ortusenler birlesir, cok kisa atilir, sure sinirlanir',
);
assert.deepStrictEqual(media.normalizeSegments({ trimStart: 2, trimEnd: 5 }, 10), [{ start: 2, end: 5 }]);
assert.deepStrictEqual(media.normalizeSegments({ segments: [{ start: 3, end: 3 }], trimStart: 1, trimEnd: 2 }, 10), [{ start: 1, end: 2 }], 'gecersiz bolumlerde secime donulur');
const segOptions = { mode: 'crf', codec: 'h264', crf: 20, speed: 1, audioMode: 'original', segments: [{ start: 1, end: 4 }, { start: 6, end: 8 }] };
const segPlan = media.planVideo(meta8, segOptions);
assert.strictEqual(segPlan.sourceDuration, 5);
assert.strictEqual(media.planVideo(meta8, { ...segOptions, speed: 2 }).duration, 2.5);
const segArgs = media.buildVideoArgs('in.mp4', meta8, segOptions, 'out.tmp', segPlan).args;
assert.strictEqual(segArgs.filter((arg) => arg === '-i').length, 2, 'her bolum ayri giris');
assert.deepStrictEqual(segArgs.slice(segArgs.indexOf('-ss'), segArgs.indexOf('-ss') + 6), ['-ss', '1.000000', '-t', '3.000000', '-i', 'in.mp4']);
const segGraph = valueOf(segArgs, '-filter_complex');
assert.ok(segGraph.includes('[v0][a0_0][v1][a1_0]concat=n=2:v=1:a=1[vc][ac0]'));
assert.ok(segGraph.includes(`[vc]${EVEN_CROP}[vout]`));
assert.ok(has(segArgs, '-map', '[vout]', '[ac0]', '-c:a', 'aac', '-sn') && !segArgs.includes('-vf'));
assert.strictEqual(valueOf(segArgs, '-map_chapters'), '-1');
// Hiz: concat sonrasi setpts/atempo, metin bolum basina kaydirilir
const segSpeed = media.buildVideoArgs('in.mp4', { ...meta8, fps: 30 }, { ...segOptions, speed: 2 }, 'out.tmp',
  media.planVideo(meta8, { ...segOptions, speed: 2 }), { overlay: { filters: ['subtitles=text.ass'] } }).args;
const speedGraph = valueOf(segSpeed, '-filter_complex');
assert.ok(speedGraph.includes('[0:v:0]setpts=PTS+1.000000/TB,subtitles=text.ass,setpts=PTS-STARTPTS'));
assert.ok(speedGraph.includes('[1:v:0]setpts=PTS+6.000000/TB,subtitles=text.ass'));
assert.ok(speedGraph.includes('[vc]setpts=PTS/2,fps=30,') && speedGraph.includes('[ac0]atempo=2.0000[ao0]'));
assert.ok(segSpeed.includes('[ao0]'));
// Hedef boyut analiz gecisi: ses yok, concat a=0
const segSize = { ...segOptions, mode: 'size', targetMB: 5 };
const segPass1 = media.buildVideoArgs('in.mp4', meta8, segSize, 'out.tmp', media.planVideo(meta8, segSize), { pass: 1 }).args;
assert.ok(valueOf(segPass1, '-filter_complex').includes('concat=n=2:v=1:a=0[vc]') && segPass1.includes('-an'));
// Iki ses izi: her iz ayri birlestirilir
const segTwo = media.buildVideoArgs('in.mkv', multiMeta, { ...segOptions, codec: 'h264' }, 'out.tmp', media.planVideo(multiMeta, segOptions)).args;
assert.ok(valueOf(segTwo, '-filter_complex').includes('concat=n=2:v=1:a=2[vc][ac0][ac1]'));
// Kayipsiz cok bolum bolum bolum yapilir (exportVideo)
assert.throws(() => media.buildVideoArgs('in.mp4', meta8, { ...segOptions, mode: 'copy' }, 'out.tmp', media.planVideo(meta8, { ...segOptions, mode: 'copy' })), /bölüm/);

// u) Video birlestirme
const clipA = { width: 1280, height: 720, videoCodec: 'h264', profile: 'High', pixFmt: 'yuv420p', fps: 30, hasAudio: true, audioCodec: 'aac', audioSampleRate: 48000, audioChannels: 2, duration: 3, ext: 'mp4', bitDepth: 8 };
assert.deepStrictEqual(shared.mergeCompatibility([clipA, { ...clipA, duration: 9 }]), { compatible: true, reasons: [] });
assert.deepStrictEqual(
  shared.mergeCompatibility([clipA, { ...clipA, width: 720, height: 1280, fps: 25, hasAudio: false }]).reasons,
  ['çözünürlük', 'kare hızı', 'ses varlığı'],
);
assert.deepStrictEqual(shared.mergeCompatibility([clipA, { ...clipA, audioSampleRate: 44100 }]).reasons, ['ses biçimi']);
assert.throws(() => media.planMerge([clipA], {}), /en az iki/);
const losslessPlan = media.planMerge([clipA, clipA], { mode: 'auto' });
assert.ok(losslessPlan.lossless && losslessPlan.ext === '.mp4' && losslessPlan.duration === 6);
assert.strictEqual(media.planMerge([clipA, clipA], { mode: 'reencode' }).lossless, false);
const mixed = [clipA, { ...clipA, width: 721, height: 1281, fps: 25, hasAudio: false, duration: 2 }];
const mixedPlan = media.planMerge(mixed, { codec: 'vp9' });
assert.ok(!mixedPlan.lossless && mixedPlan.ext === '.webm' && mixedPlan.width === 1280 && mixedPlan.fps === 30 && mixedPlan.hasAudio);
const mergeArgs = media.buildMergeArgs(['a.mp4', 'b.mp4'], mixed, { crf: 20, preset: 'fast' }, mixedPlan, 'out.webm');
const mergeGraph = valueOf(mergeArgs, '-filter_complex');
assert.ok(mergeGraph.includes('[1:v:0]scale=1280:720:force_original_aspect_ratio=decrease'));
assert.ok(mergeGraph.includes('pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30'));
assert.ok(mergeGraph.includes('anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.000,asetpts=PTS-STARTPTS[a1]'), 'sessiz videoya sessizlik eklenir');
assert.ok(mergeGraph.includes('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]'));
assert.ok(has(mergeArgs, '-c:a', 'libopus', '-c:v', 'libvpx-vp9', '-crf', '20'));
const mutePlan = media.planMerge(mixed, { audioMode: 'none' });
const muteArgs = media.buildMergeArgs(['a.mp4', 'b.mp4'], mixed, {}, mutePlan, 'out.mp4', 'nvenc');
assert.ok(valueOf(muteArgs, '-filter_complex').includes('concat=n=2:v=1:a=0[vout]') && muteArgs.includes('-an') && muteArgs.includes('h264_nvenc'));

// 10) Piksel formatindan bit derinligi
assert.strictEqual(media.pixelBitDepth('yuv420p'), 8);
assert.strictEqual(media.pixelBitDepth('yuvj420p'), 8);
assert.strictEqual(media.pixelBitDepth('nv12'), 8);
assert.strictEqual(media.pixelBitDepth('p010le'), 10);
assert.strictEqual(media.pixelBitDepth('p016le'), 16);
assert.strictEqual(media.pixelBitDepth('p210le'), 10);
assert.strictEqual(media.pixelBitDepth('p216le'), 16);
assert.strictEqual(media.pixelBitDepth('p410le'), 10);
assert.strictEqual(media.pixelBitDepth('yuv420p10le'), 10);
assert.strictEqual(media.pixelBitDepth('yuv422p12le'), 12);
assert.strictEqual(media.pixelBitDepth('yuv444p9be'), 9);
assert.strictEqual(media.pixelBitDepth('gray10le'), 10);
assert.strictEqual(media.pixelBitDepth('gbrp10le'), 10);
assert.strictEqual(media.pixelBitDepth('gbrpf32le'), 10);
assert.strictEqual(media.pixelBitDepth('rgb48le'), 16);
assert.strictEqual(media.pixelBitDepth(''), 8);
assert.strictEqual(media.pixelBitDepth('bozuk'), 8);


// Ses de kaynaktan yuksek kodlanmaz
const lowAudio = shared.sizeModeBitrates({ targetMB: 10, duration: 60, audioTracks: 1, sourceAudioKbps: 70 });
assert.strictEqual(lowAudio.audioKbps, 80);
// Kaynak hedefe sigiyorsa ve gorsel degisiklik yoksa kopyalanir
const fitMeta = { ...meta8, ext: 'mp4', size: 3e6, duration: 20 };
const fitOptions = { mode: 'size', codec: 'h264', audioMode: 'original', speed: 1, targetMB: 10, trimStart: 0, trimEnd: 20 };
assert.ok(media.sizeFitsAsCopy(fitMeta, fitOptions, media.planVideo(fitMeta, fitOptions)));
assert.ok(!media.sizeFitsAsCopy({ ...fitMeta, size: 30e6 }, fitOptions, media.planVideo(fitMeta, fitOptions)));
assert.ok(!media.sizeFitsAsCopy(fitMeta, { ...fitOptions, rotation: 90 }, media.planVideo(fitMeta, fitOptions)));
// Kopyalanan seste anahtar kare beklenmez (bazi MKV kayitlarinda ses kayboluyordu)
const audioCopyArgs = media.buildVideoArgs('in.mkv', meta8, { ...fitOptions, mode: 'copy' }, 'out.mp4', media.planVideo(fitMeta, { ...fitOptions, mode: 'copy' })).args;
assert.ok(audioCopyArgs.includes('-copyinkf:a'));

// s) Akilli kesim: bas (kodlanir) + kuyruk (kopyalanir)
assert.deepStrictEqual(shared.smartCutSplit([0, 0.5, 3.333], 2.2, 9, 1 / 60), { head: [2.2, 3.333], tail: [3.333, 9] });
assert.deepStrictEqual(shared.smartCutSplit([0, 2.2], 2.2, 9), { head: null, tail: [2.2, 9] });
assert.deepStrictEqual(shared.smartCutSplit([0], 2.2, 9), { head: [2.2, 9], tail: null });
assert.ok(shared.smartCutSupported({ videoCodec: 'h264', pixFmt: 'yuv420p' }));
assert.ok(shared.smartCutSupported({ videoCodec: 'vp9', pixFmt: 'yuv420p' }));
assert.ok(!shared.smartCutSupported({ videoCodec: 'hevc', pixFmt: 'yuv420p' }), 'hvc1 parametre degisimine izin vermez');
assert.ok(!shared.smartCutSupported({ videoCodec: 'h264', pixFmt: 'yuv444p' }));
const smartMeta = { ...meta8, videoCodec: 'h264', pixFmt: 'yuv420p', profile: 'Main', level: 31 };
const headArgs = media.smartHeadEncoderArgs(smartMeta);
assert.ok(has(headArgs, '-c:v', 'libx264') && has(headArgs, '-profile:v', 'main') && has(headArgs, '-level:v', '3.1'));
assert.ok(has(media.smartHeadEncoderArgs({ ...smartMeta, pixFmt: 'yuvj420p' }), '-color_range', 'pc'));
const trimCopy = { mode: 'copy', speed: 1, audioMode: 'original', trimStart: 2, trimEnd: 6 };
assert.ok(media.wantsSmartCut(smartMeta, trimCopy, media.planVideo(smartMeta, trimCopy)));
assert.ok(!media.wantsSmartCut(smartMeta, { ...trimCopy, trimStart: 0 }, media.planVideo(smartMeta, { ...trimCopy, trimStart: 0 })), 'bastan kesimde gerek yok');
assert.ok(!media.wantsSmartCut({ ...smartMeta, videoCodec: 'hevc' }, trimCopy, media.planVideo(smartMeta, trimCopy)));

// t) Sessiz kisimlari cikarma
const log = [
  '[silencedetect @ 0] silence_start: 2.5',
  '[silencedetect @ 0] silence_end: 4 | silence_duration: 1.5',
  '[silencedetect @ 0] silence_start: 10.2',
].join('\n');
assert.deepStrictEqual(media.parseSilenceLog(log, 12), [{ start: 2.5, end: 4 }, { start: 10.2, end: 12 }]);
assert.deepStrictEqual(shared.keepRangesFromSilences([{ start: 2.5, end: 4 }, { start: 10.2, end: 12 }], 0, 12),
  [{ start: 0, end: 2.65 }, { start: 3.85, end: 10.35 }]);
// Cok kisa kalan parca (basta 0,2 sn) atilir; secim disindaki sessizlik yok sayilir
assert.deepStrictEqual(shared.keepRangesFromSilences([{ start: 0.05, end: 1 }, { start: 8, end: 9 }], 0, 3),
  [{ start: 0.85, end: 3 }]);
assert.deepStrictEqual(shared.keepRangesFromSilences([], 1, 3), [{ start: 1, end: 3 }]);

// u) Gezgin sag tik: "Odak ile kucult"
const quick = require('../electron/quick-compress.js');
const thisFile = require('node:path').resolve(__filename);
assert.strictEqual(quick.compressRequestFromArgs(['odak.exe', thisFile], () => true), null, 'bayraksiz acilis editoru acar');
assert.deepStrictEqual(quick.compressRequestFromArgs(['odak.exe', '--compress=discord', thisFile], () => true), { preset: 'discord', files: [thisFile] });
assert.strictEqual(quick.compressRequestFromArgs(['odak.exe', '--compress=bilinmeyen', thisFile], () => true), null);
assert.strictEqual(quick.compressRequestFromArgs(['odak.exe', '--compress=discord', thisFile], () => false), null, 'video olmayan dosya atlanir');
const quickOpts = quick.quickCompressOptions({ width: 1920, height: 1080, duration: 30, hasAudio: true }, 'discord');
assert.strictEqual(quickOpts.mode, 'size');
assert.strictEqual(quickOpts.targetMB, 9.5);
assert.deepStrictEqual(quickOpts.resize, { width: 1280, height: 720 });
const portrait = quick.quickCompressOptions({ width: 720, height: 1280, duration: 30, hasAudio: false }, 'whatsapp');
assert.strictEqual(portrait.resize, null, 'kucuk video buyutulmez');
assert.strictEqual(portrait.audioMode, 'none');
assert.strictEqual(quick.quickCompressOptions({ width: 3840, height: 2160, duration: 9 }, 'email').resize, null, 'e-posta ayarinda boyut siniri yok');
assert.strictEqual(quick.quickCompressBaseName('C:/v/tatil.mp4', 'email'), 'tatil-eposta');
assert.strictEqual(quick.quickCompressOptions({ width: 1920, height: 1080, duration: 30, size: 13e6 }, 'whatsapp').resize, null,
  'hedefe zaten sigan video kucultulmez, kopyalanir');

// r) Kesim kutusundaki zaman: dakika:saniye, saat ve virgullu saniye
assert.strictEqual(shared.parseTimecode('1:05.5'), 65.5);
assert.strictEqual(shared.parseTimecode('01:02:03,25'), 3723.25);
assert.strictEqual(shared.parseTimecode('65,5'), 65.5);
assert.strictEqual(shared.parseTimecode('00:04.00'), 4);
assert.ok(Number.isNaN(shared.parseTimecode('abc')));
assert.ok(Number.isNaN(shared.parseTimecode('1::2')));
assert.ok(Number.isNaN(shared.parseTimecode('1.5:2')));
assert.ok(Number.isNaN(shared.parseTimecode('')));

console.log('VIDEO-FILTER-TEST-OK');
