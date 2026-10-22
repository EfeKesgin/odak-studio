'use strict';

// Basit hata kaydı: kullanıcı veri klasöründeki logs/odak.log dosyasına
// zaman damgalı satırlar yazar. Dosya yalnızca bu bilgisayarda kalır; bir
// sorun bildirirken kullanıcı Yardım → "Hata kaydını aç" ile paylaşabilir.
// 1 MB'ı geçince eski kayıt odak.log.1 olarak saklanır (en fazla ~2 MB).
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const MAX_DETAILS = 4000;
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'odak.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    file = null;
  }
  return file;
}

function stringify(details) {
  if (details === undefined || details === null || details === '') return '';
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
}

function write(level, message, details) {
  if (!file) return;
  const extra = stringify(details);
  const line = `${new Date().toISOString()} [${level}] ${String(message).replace(/\s+/g, ' ').trim()}` +
    `${extra ? `\n    ${extra.replace(/\n/g, '\n    ')}` : ''}\n`;
  try {
    // Eşzamanlı yazım: uygulama çökerken de satır kaybolmasın.
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    // Kayıt yazılamazsa uygulama çalışmaya devam eder.
  }
}

module.exports = {
  init,
  info: (message, details) => write('info', message, details),
  warn: (message, details) => write('warn', message, details),
  error: (message, details) => write('error', message, details),
  get file() {
    return file;
  },
};
