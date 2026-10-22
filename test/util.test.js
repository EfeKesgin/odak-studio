'use strict';
// Odak Studio - yardimci fonksiyon testleri (Electron/FFmpeg yok)
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const util = require('../electron/util.js');

(async () => {
  // sanitizeBaseName
  assert.strictEqual(util.sanitizeBaseName('  tati l  video  '), 'tati l video');
  assert.strictEqual(util.sanitizeBaseName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.strictEqual(util.sanitizeBaseName('...'), 'odak-cikti');
  assert.strictEqual(util.sanitizeBaseName('', 'yedek'), 'yedek');
  assert.strictEqual(util.sanitizeBaseName('CON'), 'CON-odak');
  assert.strictEqual(util.sanitizeBaseName('com3.txt'), 'com3.txt-odak');
  assert.strictEqual(util.sanitizeBaseName('tatil.mp4'), 'tatil');
  assert.strictEqual(util.sanitizeBaseName('foto.HEIC'), 'foto');
  assert.strictEqual(util.sanitizeBaseName('a.final'), 'a.final');
  assert.strictEqual(util.sanitizeBaseName('CON.mp4'), 'CON-odak');
  assert.strictEqual(util.sanitizeBaseName('   .mp4  ', 'yedek'), 'yedek');
  assert.ok(util.sanitizeBaseName('a'.repeat(300)).length <= 120);
  assert.ok(util.sanitizeBaseName('a'.repeat(300) + '.mp4').length <= 120);

  // normalizeExt
  assert.strictEqual(util.normalizeExt('MP4'), '.mp4');
  assert.strictEqual(util.normalizeExt('.MOV'), '.mov');
  assert.strictEqual(util.normalizeExt(''), '');

  // parseRate
  assert.strictEqual(util.parseRate('30000/1001'), 30000 / 1001);
  assert.strictEqual(util.parseRate('25/1'), 25);
  assert.strictEqual(util.parseRate('25/0'), 0);
  assert.strictEqual(util.parseRate('bozuk'), 0);
  assert.strictEqual(util.parseRate(null), 0);

  // formatDuration
  assert.strictEqual(util.formatDuration(0), '00:00');
  assert.strictEqual(util.formatDuration(65.9), '01:05');
  assert.strictEqual(util.formatDuration(3661), '1:01:01');

  // clamp
  assert.strictEqual(util.clamp(5, 0, 3), 3);
  assert.strictEqual(util.clamp(-5, 0, 3), 0);
  assert.strictEqual(util.clamp(2, 0, 3), 2);

  // ffmpegError mesajlari
  assert.match(util.ffmpegError('No space left on device', 'x').message, /Diskte/);
  assert.match(util.ffmpegError('Permission denied', 'x').message, /izinlerini/);
  assert.match(util.ffmpegError('Invalid data found when processing input', 'x').message, /bozuk/);
  assert.match(util.ffmpegError('Unknown encoder libfoo', 'x').message, /codec/);
  const generic = util.ffmpegError('line1\nline2', 'Genel hata');
  assert.strictEqual(generic.message, 'Genel hata');
  assert.match(generic.details, /line1/);

  // uniquePath: ayni ada sahip dosya varsa (1) ekler
  const dir = path.join(os.tmpdir(), 'odak-util-test');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    const first = await util.uniquePath(dir, 'klip', '.mp4');
    assert.strictEqual(path.basename(first), 'klip.mp4');
    await fsp.writeFile(first, 'x');
    const second = await util.uniquePath(dir, 'klip', 'mp4');
    assert.strictEqual(path.basename(second), 'klip (1).mp4');
    await fsp.writeFile(second, 'x');
    const third = await util.uniquePath(dir, 'klip', '.mp4');
    assert.strictEqual(path.basename(third), 'klip (2).mp4');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log('UTIL-TEST-OK');
})().catch((error) => {
  console.error('UTIL-TEST-FAIL', error);
  process.exit(1);
});
