'use strict';
// Odak Studio - saf GIF planlama/filtre testleri (FFmpeg calistirmaz)
const assert = require('node:assert');
const gif = require('../electron/gif.js');

// 1) Oran ve merkez kirpma
assert.strictEqual(gif.ratioValue('16:9'), 16 / 9);
assert.strictEqual(gif.ratioValue('1:1'), 1);
assert.strictEqual(gif.ratioValue('bilinmeyen'), 0);
assert.deepStrictEqual(
  gif.centeredCrop(320, 240, 1),
  { width: 240, height: 240, x: 40, y: 0 },
);
assert.deepStrictEqual(
  gif.centeredCrop(200, 300, 16 / 9),
  { width: 200, height: 113, x: 0, y: 94 },
);
assert.strictEqual(gif.centeredCrop(320, 240, 4 / 3), null);

const videoMeta = {
  kind: 'video', path: 'a.mp4', name: 'a.mp4',
  width: 320, height: 240, duration: 10, fps: 30,
  hasAudio: true, isHdr: false,
};
const photoMeta = {
  kind: 'image', path: 'p.jpg', name: 'p.jpg',
  width: 400, height: 200, duration: null, fps: null,
};

// 2) Video kesim/hiz + fotoğraf süresi, sabit tuval
const plan = gif.buildGifPlan([
  { path: 'a.mp4', meta: videoMeta, trimStart: 2, trimEnd: 6, speed: 2, cropRatio: '1:1' },
  { path: 'p.jpg', meta: photoMeta, duration: 1.5, cropRatio: 'auto' },
], { width: 480, fps: 10, loop: 3, ratio: '16:9' });

assert.strictEqual(plan.width, 480);
assert.strictEqual(plan.height, 270);
assert.strictEqual(plan.fps, 10);
assert.strictEqual(plan.loop, 3);
assert.strictEqual(plan.clips[0].duration, 2);
assert.strictEqual(plan.clips[1].duration, 1.5);
assert.strictEqual(plan.duration, 3.5);
assert.strictEqual(plan.frames, 35);
assert.deepStrictEqual(plan.clips[0].crop, { width: 240, height: 240, x: 40, y: 0 });
assert.deepStrictEqual(plan.clips[1].crop, { width: 356, height: 200, x: 22, y: 0 });

// 3) Otomatik tuval ilk klibin oranini kullanir
const autoPlan = gif.buildGifPlan([
  { path: 'a.mp4', meta: videoMeta, trimStart: 0, trimEnd: 1 },
], { width: 320, fps: 12, loop: 0, ratio: 'auto' });
assert.strictEqual(autoPlan.width, 320);
assert.strictEqual(autoPlan.height, 240);
assert.strictEqual(autoPlan.clips[0].crop, null);
assert.strictEqual(autoPlan.loop, 0);

// 4) Filtre grafigi: hiz, fps, kirpma, tuval, palet
const filter = gif.buildGifFilterGraph(plan);
assert.ok(filter.includes('[0:v]setpts=PTS/2.0000,fps=10,crop=240:240:40:0'));
assert.ok(filter.includes('scale=480:270:force_original_aspect_ratio=decrease:flags=lanczos'));
assert.ok(filter.includes('pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black'));
assert.ok(filter.includes('[v0][v1]concat=n=2:v=1:a=0[cat]'));
assert.ok(filter.includes('palettegen=stats_mode=diff:max_colors=256[palette]'));
assert.ok(filter.includes('paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]'));
assert.ok(!filter.includes('tonemap='), 'SDR klip ton eşlemesi kullanmaz');

// 5) HDR kaynak SDR'ye ton eşlenir (GIF 8-bit SDR)
const hdrPlan = gif.buildGifPlan([
  {
    path: 'hdr.mp4',
    meta: { ...videoMeta, isHdr: true, colorPrimaries: 'bt2020', colorTransfer: 'smpte2084', colorSpace: 'bt2020nc' },
    trimStart: 0,
    trimEnd: 1,
  },
], { width: 320, fps: 10, ratio: '16:9' });
const hdrFilter = gif.buildGifFilterGraph(hdrPlan);
assert.ok(hdrFilter.includes('zscale=pin=bt2020:tin=smpte2084:min=bt2020nc:t=linear:npl=100'));
assert.ok(hdrFilter.includes('tonemap=hable:desat=0'));
assert.ok(hdrFilter.indexOf('tonemap=') < hdrFilter.indexOf('fps=10'), 'ton eşleme fps öncesinde');
const hlgPlan = gif.buildGifPlan([
  { path: 'hlg.mp4', meta: { ...videoMeta, isHdr: true, colorTransfer: 'arib-std-b67' }, trimStart: 0, trimEnd: 1 },
], { width: 320, fps: 10 });
assert.ok(gif.buildGifFilterGraph(hlgPlan).includes('tin=arib-std-b67'));

// 6) Input ve cikti argumanlari
const args = gif.buildGifArgs(plan, 'out.gif');
const valueOf = (flag) => args[args.indexOf(flag) + 1];
assert.strictEqual(valueOf('-ss'), '2.000000');
assert.strictEqual(valueOf('-t'), '4.000000');
assert.ok(args.includes('-loop'));
assert.strictEqual(args[args.lastIndexOf('-loop') + 1], '3');
assert.strictEqual(valueOf('-f'), 'gif');
assert.ok(args.includes('-filter_complex'));
assert.ok(args.includes('-an'));
assert.ok(args.includes('-map'));
assert.strictEqual(args[args.length - 1], 'out.gif');
assert.ok(!args.includes('-c:v'));

// 6b) Fotoğraf girişi "-loop 1" kullanmaz: GIF/AVIF okuyucularında bu seçenek
// yoktur ve FFmpeg dosyayı açamaz. Tekrar, filtre grafiğinde yapılır.
assert.strictEqual(args.filter((arg) => arg === '-loop').length, 1, 'yalnızca çıktı döngü sayısı');
assert.ok(args.indexOf('-loop') > args.lastIndexOf('-i'), '-loop yalnızca çıktı seçeneği');
const photoInput = args.indexOf('p.jpg');
assert.deepStrictEqual(args.slice(photoInput - 3, photoInput + 1), ['-t', '1.500000', '-i', 'p.jpg']);
assert.ok(filter.includes('[1:v]loop=loop=-1:size=1,fps=10,'), 'fotoğraf karesi filtreyle tekrarlanır');
assert.ok(!filter.includes('[0:v]loop='), 'video klip tekrarlanmaz');
for (const name of ['p.gif', 'p.avif']) {
  const imagePlan = gif.buildGifPlan([
    { path: name, meta: { ...photoMeta, path: name, name }, duration: 2 },
  ], { width: 320, fps: 10 });
  const imageArgs = gif.buildGifArgs(imagePlan, 'out.gif');
  assert.deepStrictEqual(imageArgs.slice(imageArgs.indexOf(name) - 3, imageArgs.indexOf(name) + 1), ['-t', '2.000000', '-i', name]);
  assert.ok(gif.buildGifFilterGraph(imagePlan).startsWith('[0:v]loop=loop=-1:size=1,'));
}

// 6c) Metin, birlestirilmis tuvale palet hesabindan once cizilir; zamanlama yok
const textPlan = gif.buildGifPlan([
  { path: 'a.mp4', meta: videoMeta, trimStart: 0, trimEnd: 2 },
  { path: 'p.jpg', meta: photoMeta, duration: 1 },
], { width: 320, fps: 10, textLayers: [{ text: 'ÜST', y: 0.1, start: 5, end: 6 }, { text: '' }] });
assert.strictEqual(textPlan.textLayers.length, 1);
assert.strictEqual(textPlan.textLayers[0].start, 0);
assert.strictEqual(textPlan.textLayers[0].end, null);
assert.ok(gif.buildGifFilterGraph(textPlan).includes('[cat]subtitles=text.ass,split[pal][use]'));
const singleText = gif.buildGifPlan([{ path: 'a.mp4', meta: videoMeta, trimStart: 0, trimEnd: 1 }], { textLayers: [{ text: 'x' }] });
assert.ok(gif.buildGifFilterGraph(singleText).includes('[v0]subtitles=text.ass,split[pal][use]'));
assert.ok(!gif.buildGifFilterGraph(plan).includes('subtitles='), 'metin yoksa filtre eklenmez');

// 7) Tek klip concat kullanmaz
const singleFilter = gif.buildGifFilterGraph(autoPlan);
assert.ok(singleFilter.includes('[v0]split[pal][use]'));
assert.ok(!singleFilter.includes('concat='));

// 8) Sinirlar ve hatalar
assert.throws(() => gif.buildGifPlan([], {}), /en az bir/);
assert.throws(
  () => gif.buildGifPlan([{ path: 'a.mp4', meta: { ...videoMeta, duration: 70 } }], { fps: 12 }),
  /çok uzun/,
);
assert.throws(
  () => gif.buildGifPlan([{ path: 'a.mp4', meta: { ...videoMeta, duration: 60 } }], { fps: 20 }),
  /çok uzun/,
);

// 9) Fotoğraf süresi ve hız sınırları
const photoPlan = gif.buildGifPlan([
  { path: 'p.jpg', meta: photoMeta, duration: 50, cropRatio: '1:1' },
], { width: 160, fps: 8, ratio: '1:1' });
assert.strictEqual(photoPlan.clips[0].duration, 30);
const shortPhoto = gif.buildGifPlan([
  { path: 'p.jpg', meta: photoMeta, duration: 0.01 },
], { fps: 8 });
assert.strictEqual(shortPhoto.clips[0].duration, 0.1);

console.log('GIF-PLAN-TEST-OK');
