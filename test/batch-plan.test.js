'use strict';
// Toplu işlem planlama testleri (Electron/FFmpeg gerektirmez)
const assert = require('node:assert/strict');
const plan = require('../src/batch-plan.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

test('video varsayılanları kayıpsız kopya ve orijinal boyut', () => {
  const options = plan.buildVideoOptions({}, {
    width: 1920,
    height: 1080,
    duration: 8,
    hasAudio: true,
  });
  assert.equal(options.mode, 'copy');
  assert.equal(options.resize, null);
  assert.equal(options.trimStart, 0);
  assert.equal(options.trimEnd, 8);
  assert.equal(options.audioMode, 'original');
});

test('kayıpsız kopya görsel işlem yokken korunur', () => {
  const options = plan.buildVideoOptions({ quality: 'copy' }, {
    width: 1280,
    height: 720,
    duration: 4,
    hasAudio: false,
  });
  assert.equal(options.mode, 'copy');
  assert.equal(options.audioMode, 'none');
});

test('boyut küçültmede kopya CRF olur ve oran korunur', () => {
  const options = plan.buildVideoOptions({ quality: 'copy', maxWidth: 1280 }, {
    width: 3840,
    height: 2160,
    duration: 3,
    hasAudio: true,
  });
  assert.equal(options.mode, 'crf');
  assert.deepEqual(options.resize, { width: 1280, height: 720 });
});

test('küçük video büyütülmez ve tek piksel boyut üretilmez', () => {
  assert.equal(plan.videoResize({ maxWidth: 1920 }, { width: 1280, height: 720 }), null);
  assert.deepEqual(
    plan.videoResize({ maxWidth: 640 }, { width: 1001, height: 563 }),
    { width: 640, height: 360 },
  );
});

test('dikey videoda sınır uzun kenara uygulanır', () => {
  assert.deepEqual(
    plan.videoResize({ maxWidth: 1280 }, { width: 1080, height: 1920 }),
    { width: 720, height: 1280 },
  );
  assert.deepEqual(
    plan.videoResize({ maxWidth: 1920 }, { width: 2160, height: 3840 }),
    { width: 1080, height: 1920 },
  );
  // Uzun kenarı sınırın altında kalan dikey video dokunulmadan kalır.
  assert.equal(plan.videoResize({ maxWidth: 1920 }, { width: 1080, height: 1920 }), null);
});

test('hedef dosya boyutu toplu ayarlarda korunur', () => {
  const options = plan.buildVideoOptions({ quality: 'size', targetMB: 25 }, {
    width: 1920, height: 1080, duration: 30, hasAudio: true,
  });
  assert.equal(options.mode, 'size');
  assert.equal(options.targetMB, 25);
  assert.equal(plan.normalizeVideoSettings({ quality: 'size', targetMB: -5 }).targetMB, 10);
  assert.equal(plan.normalizeVideoSettings({ quality: 'size', targetMB: 7.26 }).targetMB, 7.3);
  // ProRes boyut hedefini desteklemez
  assert.equal(plan.normalizeVideoSettings({ quality: 'size', codec: 'prores' }).quality, 'crf');
});

test('birleştirme ayarları normalize edilir', () => {
  assert.deepEqual(plan.normalizeSettings('merge', {}), plan.defaultsFor('merge'));
  assert.deepEqual(
    plan.normalizeSettings('merge', { mode: 'reencode', codec: 'prores', crf: 99, preset: 'x', encoder: 'gpu', audioMode: 'none' }),
    { mode: 'reencode', codec: 'h264', crf: 30, preset: 'medium', encoder: 'gpu', audioMode: 'none' },
  );
  assert.equal(plan.normalizeKind('merge'), 'merge');
});

test('kodlayıcı seçimi (işlemci/ekran kartı) dosyalara aktarılır', () => {
  assert.equal(plan.normalizeVideoSettings({}).encoder, 'cpu');
  assert.equal(plan.normalizeVideoSettings({ encoder: 'gpu' }).encoder, 'gpu');
  assert.equal(plan.normalizeVideoSettings({ encoder: 'quantum' }).encoder, 'cpu');
  const options = plan.buildVideoOptions({ quality: 'crf', encoder: 'gpu' }, { width: 1280, height: 720, duration: 5 });
  assert.equal(options.encoder, 'gpu');
});

test('hazır ayarlar geçerli ve kayıtlı ayarlar temizlenir', () => {
  const shared = require('../src/shared.js');
  for (const preset of shared.VIDEO_PRESETS) {
    assert.deepEqual(shared.cleanVideoPresetSettings(preset.settings), preset.settings, preset.id);
    // Toplu işlemde de aynı ayar geçerli olmalı (uzun kenar seçenekleri dahil)
    const batch = plan.normalizeSettings('video', { ...preset.settings, maxWidth: preset.settings.maxEdge || 0 });
    assert.equal(batch.maxWidth, preset.settings.maxEdge || 0, preset.id);
  }
  assert.deepEqual(
    shared.cleanVideoPresetSettings({ codec: 'prores', quality: 'size', crf: 99, targetMB: -1, evil: 'x' }),
    { codec: 'prores', quality: 'crf' },
  );
  const users = shared.cleanUserPresets([
    { id: 'user-a', name: '  Benim   ayarım ', settings: { codec: 'h265', quality: 'crf', crf: 22 } },
    { id: 'user-a', name: 'kopya id', settings: { quality: 'crf' } },
    { id: '../kötü', name: 'x', settings: { quality: 'crf' } },
    { id: 'user-b', name: 'kalite yok', settings: { codec: 'h264' } },
    null,
  ]);
  assert.deepEqual(users, [{ id: 'user-a', name: 'Benim ayarım', settings: { codec: 'h265', quality: 'crf', crf: 22 } }]);
  assert.deepEqual(shared.cleanUserPresets('bozuk'), []);
});

test('ses seçenekleri dosya bazında uygulanır', () => {
  assert.equal(
    plan.buildVideoOptions({ audioMode: 'aac' }, { duration: 1, hasAudio: true }).audioMode,
    'aac',
  );
  assert.equal(
    plan.buildVideoOptions({ audioMode: 'aac' }, { duration: 1, hasAudio: false }).audioMode,
    'none',
  );
  assert.equal(
    plan.buildVideoOptions({ audioMode: 'none' }, { duration: 1, hasAudio: true }).audioMode,
    'none',
  );
});

test('ProRes bit hızı CRFye düşer', () => {
  const normalized = plan.normalizeVideoSettings({ codec: 'prores', quality: 'bitrate', crf: 18 });
  assert.equal(normalized.quality, 'crf');
  assert.equal(normalized.crf, 18);
});

test('fotoğraf uzun kenarı oranı bozmadan küçültür', () => {
  const ops = plan.photoOps({ maxEdge: 1920 }, { width: 4000, height: 3000 });
  assert.deepEqual(ops, [{ type: 'resize', width: 1920, height: 1440 }]);
});

test('fotoğraf dikey oranda uzun kenarı korur', () => {
  const ops = plan.photoOps({ maxEdge: 1080 }, { width: 2000, height: 4000 });
  assert.deepEqual(ops, [{ type: 'resize', width: 540, height: 1080 }]);
});

test('küçük fotoğraf büyütülmez', () => {
  assert.deepEqual(plan.photoOps({ maxEdge: 1920 }, { width: 800, height: 600 }), []);
  assert.deepEqual(plan.photoOps({ maxEdge: 0 }, { width: 4000, height: 3000 }), []);
});

test('fotoğraf biçim seçenekleri normalize edilir', () => {
  assert.deepEqual(plan.buildPhotoOptions({ format: 'jpeg', quality: 'high', keepMetadata: false }), {
    format: 'jpeg',
    quality: 'high',
    keepMetadata: false,
  });
  assert.equal(plan.buildPhotoOptions({ format: 'bmp' }).format, 'original');
});

test('GIF video süresi sınırlandırılır', () => {
  const item = plan.buildGifItem({ fps: 12, maxSeconds: 5 }, {
    kind: 'video',
    name: 'klip.mp4',
    duration: 12,
  }, 'klip.mp4');
  assert.deepEqual(item, {
    path: 'klip.mp4',
    trimStart: 0,
    trimEnd: 5,
    speed: 1,
  });
});

test('GIF fotoğrafı 2 saniye görünür ve oran kırpılır', () => {
  const item = plan.buildGifItem({ fps: 12, ratio: '1:1' }, {
    kind: 'image',
    name: 'foto.jpg',
    width: 800,
    height: 600,
  }, 'foto.jpg');
  assert.equal(item.duration, 2);
  assert.equal(item.cropRatio, '1:1');
});

test('GIF 60 saniye sınırı anlaşılır hata verir', () => {
  assert.throws(
    () => plan.buildGifItem({ fps: 12, maxSeconds: 0 }, {
      kind: 'video',
      name: 'uzun.mp4',
      duration: 75,
    }, 'uzun.mp4'),
    /60 sn.*900 kare/,
  );
});

test('GIF 900 kare sınırı FPS ile hesaplanır', () => {
  assert.equal(plan.gifFrames(60, 24), 1440);
  assert.throws(
    () => plan.buildGifItem({ fps: 24, maxSeconds: 0 }, {
      kind: 'video',
      name: 'uzun.mp4',
      duration: 40,
    }, 'uzun.mp4'),
    /900 kare/,
  );
});

test('GIF ayarları sınırlar içinde tutulur', () => {
  const settings = plan.normalizeGifSettings({ width: 2000, fps: 17, loop: 99, ratio: 'yok' });
  assert.equal(settings.width, 960);
  assert.equal(settings.fps, 12);
  assert.equal(settings.loop, 20);
  assert.equal(settings.ratio, 'auto');
});

test('geçersiz video ayarları güvenli varsayılana döner', () => {
  const settings = plan.normalizeVideoSettings({
    codec: 'av1',
    quality: 'copy',
    crf: 99,
    preset: 'ultra',
    bitrateKbps: 1,
    maxWidth: 123,
    audioMode: 'surround',
  });
  assert.equal(settings.codec, 'h264');
  assert.equal(settings.quality, 'copy');
  assert.equal(settings.crf, 30);
  assert.equal(settings.preset, 'medium');
  assert.equal(settings.bitrateKbps, 100);
  assert.equal(settings.maxWidth, 0);
  assert.equal(settings.audioMode, 'original');
});

test('dosya adı son eki türe göre belirlenir ve iki kez eklenmez', () => {
  assert.equal(plan.suggestName('tatil', 'video'), 'tatil-odak');
  assert.equal(plan.suggestName('tatil', 'photo'), 'tatil-odak');
  assert.equal(plan.suggestName('tatil', 'gif'), 'tatil-gif');
  assert.equal(plan.suggestName('tatil-odak', 'video'), 'tatil-odak');
  assert.equal(plan.suggestName('tatil-gif', 'gif'), 'tatil-gif');
});

console.log(`BATCH-PLAN-TEST-OK (${passed} kontrol)`);
