'use strict';
// Çeviri kapsamı: arayüzdeki ve koddaki Türkçe metinlerin İngilizce karşılığı
// olmalı. Yeni bir metin eklenip src/i18n.js'e çevirisi eklenmezse bu test
// hangi metnin eksik olduğunu söyler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../src/i18n.js');

const root = path.join(__dirname, '..');
const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
let problems = 0;
const fail = (message) => { problems += 1; console.log(`FAIL  ${message}`); };

i18n.setLanguage('en');

function check(text, where) {
  const result = i18n.translate(text);
  if (result === text || TURKISH_LETTERS.test(result.replace(/<[^>]+>/g, ''))) {
    fail(`${where}: çevirisi yok → "${text}"${result !== text ? ` (çıktı: "${result}")` : ''}`);
  }
}

// 1) HTML'deki görünen metinler ve öznitelikler
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
  .replace(/<symbol[\s\S]*?<\/symbol>/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const htmlTexts = new Set();
for (const match of html.matchAll(/>([^<>]+)</g)) {
  const text = decode(match[1].replace(/\s+/g, ' ').trim());
  if (TURKISH_LETTERS.test(text)) htmlTexts.add(text);
}
for (const match of html.matchAll(/\s(?:title|placeholder|aria-label|label)="([^"]+)"/g)) {
  if (TURKISH_LETTERS.test(match[1])) htmlTexts.add(decode(match[1]));
}
// Boş ekran başlığı parçaları JS'te bütün olarak çevrilir.
// fotoğraf.jpg: dosya adı yer tutucusu (dosya adları çevrilmez).
const htmlExempt = new Set(['Videoda', 'kaliteyi', 'fotoğraf.jpg']);
for (const text of htmlTexts) if (!htmlExempt.has(text)) check(text, 'index.html');

// 2) Arayüze giden sabit metinler (tek tırnaklı, Türkçe harf içeren)
const sources = [
  'src/app.js', 'src/ui.js', 'src/video.js', 'src/photo.js', 'src/gif.js', 'src/batch.js',
  'src/batch-plan.js', 'src/text-layers.js', 'src/shared.js',
  'electron/main.js', 'electron/media.js', 'electron/photos.js', 'electron/gif.js', 'electron/util.js',
];
// Kod içi anahtarlar/değerler: ekranda gösterilmez veya kendi başına çevrilmez.
const codeExempt = new Set([
  'tr-TR', 'Segoe UI', 'Comic Sans MS', 'Times New Roman',
  // Yalnızca geliştirici konsoluna yazılır.
  'Sistem bilgisi alınamadı:', 'Arayüz başlatılamadı:',
]);
let literalCount = 0;
for (const file of sources) {
  const code = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) {
    const text = match[1].replace(/\\'/g, "'");
    if (!TURKISH_LETTERS.test(text) || codeExempt.has(text)) continue;
    // Şablon parçaları (başında/sonunda boşluk ya da noktalama) bütün mesajda test edilir.
    if (/^[ ;:·(]/.test(text) || /^[a-zçğıöşü]+$/.test(text) && text.length < 4) continue;
    literalCount += 1;
    check(text, file);
  }
}

// 3) Değişken içeren mesajlar (şablonlardan örnekler)
const samples = [
  '3 dosya kuyruğa eklendi.',
  'klip (1).mp4 kuyruğa eklendi.',
  '2 dosya kuyrukta zaten var.',
  '4 video yeniden kodlanmadan birleştirildi: tatil-birlesik.mp4',
  '2 video yeniden kodlanarak birleştirildi: a.mp4',
  'Videolar farklı (çözünürlük, kare hızı, ses varlığı); ilk videonun boyutuna ve kare hızına getirilip kodlanır.',
  'Hedef bu süre için çok küçük. En az 0,3 MB seçin, videoyu kısaltın veya sesi kapatın.',
  'Video ~7.336 kbps · ses 160 kbps. İki geçişte kodlanır; çıktı hedefin altında kalır.',
  'Ses, kapsayıcı destekliyorsa yeniden kodlanmadan kopyalanır. 2 ses izinin tamamı korunur. 2 altyazı MP4 metin altyazısı olarak korunur.',
  'Dışa aktarmada yalnızca bu 2 bölüm sırayla birleştirilir; yumuşak altyazılar taşınmaz. Seçim, yeni bölüm eklemek içindir.',
  '2. bölüm eklendi · 00:05.00 – 00:07.50',
  'Discord · 10 MB uygulandı · 1280 × 720',
  'WhatsApp · 16 MB kuyruğa uygulandı.',
  'NVIDIA NVENC ile kodlanır: birkaç kat daha hızlı, aynı kalite ayarında dosya biraz daha büyük olabilir.',
  'H.264 · en fazla 9,5 MB · 1280 × 720 · GPU',
  'H.265 (GPU) · CRF 18 · ses korunur',
  '6.5 sn · ≈ 996 KB',
  '1 dk 5 sn',
  'VİDEO • 320 × 240 • 3.0 sn',
  '3 işlem · 1 metin · kayıpsız PNG',
  'Toplu işlem durduruldu. 2 dosya tamamlandı.',
  '3 dosya tamamlandı, 1 dosyada hata oluştu. Hataları yeniden deneyebilirsin.',
  'b1.mp4 · Birleştirme işleniyor',
  'Kırpma uygulandı · 640 × 360 · boyut ayarı sıfırlandı',
  'Sınır aşıldı · en fazla 60 sn / 900 kare',
  'GIF çok uzun. En fazla 60 saniye veya 900 kare olabilir; kırpma süresini ya da FPS\'i azaltın.',
  'a.mp4: bu sekme için video gerekli.',
  'Tüm klipler aynı tuvale sığdırılır. 36 kare · 3.0 sn.',
  'Hedef boyut bütçesine göre ses AAC 128 kbps olarak kodlanır. Sesi kapatmak videoya daha çok yer bırakır.',
  'Metni üst ortaya taşı',
  '"Vlog 1080p" kaydedildi.',
  'Arayüz başlatılamadı: boom',
  '0 GIF',
];
for (const sample of samples) check(sample, 'örnek');

// 4) Yardımcılar
assert.equal(i18n.translate('%42'), '42%', 'yüzde işareti İngilizcede sona gelir');
assert.equal(i18n.translate('  Kaydet  '), '  Save  ', 'boşluklar korunur');
assert.equal(i18n.t('{n} dosya', { n: 3 }), '3 dosya', 'çevirisi olmayan şablon olduğu gibi kalır');
assert.equal(i18n.languageForLocale('tr-TR'), 'tr');
assert.equal(i18n.languageForLocale('en-US'), 'en');
assert.equal(i18n.languageForLocale('de'), 'en');
i18n.setLanguage('tr');
assert.equal(i18n.translate('Kaydet'), 'Kaydet', 'Türkçede metin değişmez');

console.log(`ok    HTML ${htmlTexts.size} metin, kod ${literalCount} metin, ${samples.length} örnek mesaj`);
console.log(problems === 0 ? 'I18N-TEST-OK' : `I18N-TEST-FAIL (${problems})`);
process.exitCode = problems === 0 ? 0 : 1;
