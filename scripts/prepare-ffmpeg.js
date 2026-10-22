'use strict';
// FFmpeg ve FFprobe'u kurulum paketine girecek "bin/" klasörüne kopyalar.
//
// Kaynak sırası:
//   1) Komut satırı: node scripts/prepare-ffmpeg.js <ffmpeg klasörü>
//   2) ODAK_FFMPEG_DIR ortam değişkeni
//   3) Sabitlenmiş gyan.dev "essentials" derlemesi: SHA-256 doğrulanarak
//      indirilir ve .cache/ffmpeg/ altında saklanır (yalnızca ilk seferde).
//      "full" derlemenin yarısı boyutundadır ve uygulamanın kullandığı her
//      kodlayıcıyı/filtreyi içerir (x264, x265, VP9, Opus, libass, zimg,
//      NVENC/QSV/AMF).
// Klasör, ffmpeg.exe'nin bulunduğu "bin" klasörü ya da onun üst klasörü
// olabilir. GPL gereği FFmpeg'in lisansı ve kaynak bilgisini taşıyan
// LICENSE/README dosyaları da (varsa) yanına kopyalanır.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'bin');
const BINARIES = ['ffmpeg.exe', 'ffprobe.exe'];
const PINNED = {
  name: 'ffmpeg-8.1.2-essentials_build',
  url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip',
  sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
};
const CACHE = path.join(ROOT, '.cache', 'ffmpeg');

function fail(message) {
  console.error(`FFmpeg hazırlanamadı: ${message}`);
  process.exit(1);
}

function binDirFrom(candidate) {
  if (!candidate) return null;
  const dir = path.resolve(candidate);
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) return dir;
  if (fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe'))) return path.join(dir, 'bin');
  return null;
}

function download(url, target, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).href, target, redirects - 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} indirilemedi (HTTP ${response.statusCode}).`));
        return;
      }
      const out = fs.createWriteStream(target);
      response.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      response.on('error', reject);
    }).on('error', reject);
  });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let read;
  while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  fs.closeSync(fd);
  return hash.digest('hex');
}

// Sabitlenmiş derlemeyi indirir, doğrular ve açar; açılmışsa yeniden indirmez.
async function pinnedBuild() {
  const extracted = path.join(CACHE, PINNED.name, 'bin');
  if (fs.existsSync(path.join(extracted, 'ffmpeg.exe'))) return extracted;
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, `${PINNED.name}.zip`);
  if (!fs.existsSync(zip) || sha256(zip) !== PINNED.sha256) {
    console.log(`indiriliyor ${PINNED.url}`);
    const partial = `${zip}.part`;
    try {
      await download(PINNED.url, partial);
    } catch (error) {
      fs.rmSync(partial, { force: true });
      fail(`${error.message} Bir FFmpeg klasörünü argüman ya da ODAK_FFMPEG_DIR ile verebilirsiniz.`);
    }
    const actual = sha256(partial);
    if (actual !== PINNED.sha256) {
      fs.rmSync(partial, { force: true });
      fail(`indirilen dosyanın SHA-256 değeri beklenenden farklı (${actual}).`);
    }
    fs.renameSync(partial, zip);
  }
  // Windows 10/11 ile gelen tar (bsdtar) zip arşivlerini açabilir; PATH'te
  // önce gelebilecek GNU tar (Git Bash) açamadığı için tam yolu kullanılır.
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tar = fs.existsSync(systemTar) ? systemTar : 'tar';
  execFileSync(tar, ['-xf', zip, '-C', CACHE], { stdio: 'inherit', windowsHide: true });
  if (!fs.existsSync(path.join(extracted, 'ffmpeg.exe'))) fail(`${zip} içinde ${PINNED.name}/bin/ffmpeg.exe yok.`);
  return extracted;
}

function sameFile(source, target) {
  try {
    const a = fs.statSync(source);
    const b = fs.statSync(target);
    return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000;
  } catch {
    return false;
  }
}

function copy(source, target) {
  if (sameFile(source, target)) {
    console.log(`değişmedi  ${path.basename(target)}`);
    return;
  }
  fs.copyFileSync(source, target);
  const stat = fs.statSync(source);
  fs.utimesSync(target, stat.atime, stat.mtime);
  console.log(`kopyalandı ${path.basename(target)} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
}

async function main() {
  const requested = process.argv[2] || process.env.ODAK_FFMPEG_DIR;
  const sourceBin = requested ? binDirFrom(requested) : await pinnedBuild();
  if (!sourceBin) fail(`${requested} içinde ffmpeg.exe bulunamadı.`);
  if (path.resolve(sourceBin) === path.resolve(TARGET)) {
    fail('Kaynak ve hedef aynı klasör (bin/). Başka bir FFmpeg klasörü verin.');
  }
  for (const name of BINARIES) {
    if (!fs.existsSync(path.join(sourceBin, name))) fail(`${sourceBin} içinde ${name} yok.`);
  }

  fs.mkdirSync(TARGET, { recursive: true });
  for (const name of BINARIES) copy(path.join(sourceBin, name), path.join(TARGET, name));

  // Lisans ve kaynak bilgisi (gyan.dev derlemelerinde üst klasördedir).
  const docs = { LICENSE: 'FFMPEG-LICENSE.txt', 'LICENSE.txt': 'FFMPEG-LICENSE.txt', 'README.txt': 'FFMPEG-README.txt' };
  let licenseFound = false;
  for (const dir of [sourceBin, path.dirname(sourceBin)]) {
    for (const [name, targetName] of Object.entries(docs)) {
      const source = path.join(dir, name);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      copy(source, path.join(TARGET, targetName));
      if (targetName === 'FFMPEG-LICENSE.txt') licenseFound = true;
    }
  }
  if (!licenseFound) {
    console.warn('Uyarı: FFmpeg lisans dosyası bulunamadı. Dağıtımdan önce bin/FFMPEG-LICENSE.txt ekleyin.');
  }

  const version = execFileSync(path.join(TARGET, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true });
  const firstLine = version.split(/\r?\n/)[0];
  console.log(firstLine);
  if (/--enable-gpl/.test(version) && !/--enable-nonfree/.test(version)) {
    console.log('Lisans: GPL derleme, uygulamanın GPL-3.0 lisansıyla uyumlu.');
  } else if (/--enable-nonfree/.test(version)) {
    fail('Bu FFmpeg "nonfree" bileşen içeriyor ve yeniden dağıtılamaz.');
  }
}

main().catch((error) => fail(error.message || String(error)));
