'use strict';

// Otomatik güncellemenin ne zaman denetleneceği. Uygulama tamamen
// çevrimdışı çalışır: internet yokken istek atılmaz, bağlantı hataları
// "hata" değil "çevrimdışı" sayılır ve internet gelince yeniden denenir.

const RECHECK_MS = 6 * 60 * 60 * 1000; // Başarılı denetimden sonra 6 saat
const RETRY_MS = 10 * 60 * 1000; // Çevrimdışı/hata sonrası en erken 10 dk
const TICK_MS = 30 * 60 * 1000; // Arka plan yoklama aralığı

const BUSY = ['checking', 'available', 'downloading', 'downloaded'];

const NETWORK_ERROR = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|net::ERR_|socket hang up|getaddrinfo/i;

function isNetworkError(error) {
  return NETWORK_ERROR.test(String(error?.code || '') + ' ' + String(error?.message || error || ''));
}

// Denetleme zamanı geldi mi? state: son güncelleme durumu; lastSuccess:
// son başarılı denetimin zamanı (ms); lastAttempt: son denemenin zamanı.
function shouldCheck({ state, online, now, lastSuccess = 0, lastAttempt = 0 }) {
  if (!online) return false;
  if (BUSY.includes(state)) return false;
  if (state === 'offline' || state === 'error' || state === 'idle' || !lastSuccess) {
    return now - lastAttempt >= RETRY_MS;
  }
  return now - lastSuccess >= RECHECK_MS;
}

module.exports = {
  RECHECK_MS,
  RETRY_MS,
  TICK_MS,
  isNetworkError,
  shouldCheck,
};
