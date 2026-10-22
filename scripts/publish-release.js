'use strict';
// Derlenmiş kurulum paketini GitHub Releases'ta yeni bir sürüm olarak yayınlar.
//
// electron-builder'ın kendi yayınlayıcısı aynı sürümü iki kez oluşturmaya
// çalışıp "422 Published releases must have a valid tag" hatasıyla yarım
// kalabiliyor (kurulum dosyası yüklenir, latest.yml yüklenmez; bu da
// güncellemeyi bozar). Burada gh CLI ile tek seferde, üç dosya birlikte
// yüklenir. Önce: `gh auth login`.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version, build } = require(path.join(ROOT, 'package.json'));
const publish = build.publish[0];
const repo = `${publish.owner}/${publish.repo}`;
const tag = `v${version}`;

function fail(message) {
  console.error(`Yayınlanamadı: ${message}`);
  process.exit(1);
}

const installer = path.join(DIST, build.nsis.artifactName.replace('${version}', version).replace('${ext}', 'exe'));
const files = [installer, `${installer}.blockmap`, path.join(DIST, 'latest.yml')];
for (const file of files) {
  if (!fs.existsSync(file)) fail(`${path.relative(ROOT, file)} yok. Önce "npm run dist" çalıştırın.`);
}

// latest.yml bu kurulum dosyasına ait olmalı; eski bir derlemeden kalmışsa
// güncelleme özet doğrulamasında başarısız olur.
const manifest = fs.readFileSync(files[2], 'utf8');
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
if (!manifest.includes(`version: ${version}`) || !manifest.includes(sha512)) {
  fail('latest.yml bu kurulum dosyasıyla eşleşmiyor. "npm run dist" ile yeniden derleyin.');
}

const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', ...options });
try {
  gh(['release', 'view', tag, '-R', repo], { stdio: 'ignore' });
  fail(`${tag} zaten yayınlanmış. package.json içindeki sürümü artırın.`);
} catch (error) {
  if (error.status === undefined) throw error;
  // Sürüm yok: yayınlanabilir.
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const notes = `Odak Studio ${version}\n\nWindows kurulum dosyası: ${path.basename(installer)}\nKurulu uygulamalar bu sürümü bir sonraki açılışta otomatik bulur.`;
gh(['release', 'create', tag, ...files, '-R', repo, '--target', head, '--title', `Odak Studio ${version}`, '--notes', notes], {
  stdio: 'inherit',
});
console.log(`Yayınlandı: https://github.com/${repo}/releases/tag/${tag}`);
