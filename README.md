# Odak Studio

Windows için sade, yerel çalışan video, fotoğraf, GIF ve toplu işlem stüdyosu. Tüm işlemler
bilgisayarında yapılır; hiçbir dosya internete yüklenmez.

## Öne çıkanlar

- **Videoda kalite koruması:** Görsel değişiklik yoksa (kesim dışında) akış kopyalama (stream copy)
  ile yeniden kodlama yapılmaz. Yeniden kodlama gerekliyse varsayılan CRF 16 ve yüksek kaliteli
  ayarlar kullanılır.
- **Video düzenleme:** Kesim, döndürme, yatay/dikey çevirme, kırpma, yeniden boyutlandırma,
  hız değiştirme, ses modu, kodek (H.264 / H.265 / VP9 / ProRes) ve kalite modu (kopya / CRF /
  bit hızı / hedef dosya boyutu).
- **Çok bölümlü kesim:** `I` / `O` ile giriş/çıkış noktası, `B` ile seçimi bölüm olarak ekleme.
  Bölümler sırayla tek dosyada birleşir; kopya modunda yeniden kodlama olmadan.
- **Hedef dosya boyutu:** "Bu videoyu 10 MB'a sığdır" — iki geçişli kodlama; çıktı hedefi
  aşarsa bir kez daha düşük bit hızıyla düzeltilir.
- **Hazır ayarlar:** YouTube, Instagram/TikTok, WhatsApp, Discord, e-posta, arşiv; kendi
  ayarlarını kaydetme. Son kullanılan ayarlar (video, fotoğraf, GIF, toplu) hatırlanır.
- **Metin ve altyazı:** Video, fotoğraf ve GIF'e yazı/filigran (yazı tipi, renk, kenarlık,
  gölge, kutu, konum, videoda zamanlama); önizlemede sürükleyerek yerleştirme. Videodaki metin
  altyazı izi görüntüye yakılabilir. Ek ses dilleri ve altyazılar çıktıya taşınır.
- **Donanım hızlandırma:** NVIDIA NVENC, Intel Quick Sync, AMD AMF (H.264/H.265). Açılışta
  gerçekten çalışan kodlayıcılar test edilir; yoksa işlemciyle kodlanır.
- **Video birleştirme:** Toplu işlemdeki "Birleştir" sekmesi. Uyumlu videolar kayıpsız, farklı
  boyut/kare hızındakiler ortak tuvale getirilerek tek dosyada birleştirilir.
- **Türkçe / İngilizce arayüz:** İlk açılışta sistem dili, sonra Yardım ekranından seçilir.
- **Fotoğraf düzenleme:** Döndürme, çevirme, kırpma, yeniden boyutlandırma, format (orijinal,
  JPEG, PNG, WebP, AVIF, TIFF), kalite ve meta veri koruma. Biçim değişmezse ve düzenleme
  yapılmazsa dosya birebir kopyalanır.
- **GIF stüdyosu:** Video ve fotoğrafları sırayla birleştirme, klipleri sürükleyerek veya
  oklarla sıralama; her klip için kesim/süre, hız ve merkezî kırpma; global tuval oranı,
  genişlik, FPS ve döngü sayısı. Çıktı, FFmpeg'in palet tabanlı GIF kodlayıcısıyla üretilir.
- **Toplu işlem:** Video, fotoğraf ve GIF için ayrı kuyruklar; çoklu dosya ekleme, ortak
  codec/kalite/boyut veya format/çözünürlük ayarları, sıralı ilerleme, dosya bazlı hata
  toleransı, yeniden deneme ve iptal. Her dosya kendi adıyla ayrı kaydedilir.
- **Önizleme:** Kare kaydetme (uygulanan döndürme/çevirme/kırpma/boyut ile),
  film şeridi, GIF önizlemesi ve yerel medya sunucusu üzerinden oynatma.
- **Derin renk:** 16-bit kaynak desteği ve ICC profili koruması (örn. Display P3).

## Gereksinimler

Kurulum paketini kullanan için yalnızca Windows 10/11 yeterli: FFmpeg paketin içindedir.

Kaynaktan çalıştırmak ve paketlemek için:

- Windows 10/11
- Node.js 20 veya üzeri
- FFmpeg ve FFprobe (8.x önerilir, GPL derleme)

Geliştirme sırasında FFmpeg sistem PATH'inde olabilir ya da proje kökündeki `bin/` klasörüne
konabilir (`npm run ffmpeg` bunu otomatik yapar):

```
bin/ffmpeg.exe
bin/ffprobe.exe
```

Alternatif olarak `ODAK_FFMPEG` ortam değişkeniyle ffmpeg.exe yolunu gösterebilirsin.

## Kurulum ve çalıştırma

```powershell
npm install
npm start
```

Geliştirme sırasında pencereyi yenileyerek çalışmak için:

```powershell
npm run dev
```

## Kurulum paketi oluşturma

```powershell
npm run dist
```

Bu komut önce `scripts/prepare-ffmpeg.js` ile FFmpeg/FFprobe'u ve FFmpeg'in lisans/kaynak
bilgisini `bin/` klasörüne kopyalar, ardından electron-builder ile
`dist/OdakStudio-Setup-<sürüm>.exe` kurulum dosyasını üretir. FFmpeg varsayılan olarak
PATH'ten alınır; başka bir derleme kullanmak için klasörü ver:

```powershell
node scripts/prepare-ffmpeg.js C:\ffmpeg\bin
npx electron-builder --win nsis
```

Kurulum dosyası olmadan, yalnızca klasör halinde denemek için `npm run pack`
(`dist/win-unpacked/`).

Notlar:

- FFmpeg ikilileri (~450 MB) depoya eklenmez (`.gitignore`), yalnızca pakete girer.
  Gyan.dev "essentials" derlemesi daha küçüktür.
- Kurulum dosyası imzasız olduğu için Windows SmartScreen ilk açılışta uyarı gösterebilir.
- `nonfree` bileşen içeren FFmpeg derlemeleri yeniden dağıtılamaz; hazırlama betiği bunları reddeder.

## Güncellemeler ve sürüm yayınlama

Kurulu uygulama açılıştan kısa süre sonra GitHub Releases'ta yeni sürüm olup olmadığına bakar.
Varsa arka planda indirir (yalnızca değişen bloklar; FFmpeg gibi değişmeyen kısımlar yeniden
inmez) ve uygulama kapanırken ya da kullanıcı "Şimdi yeniden başlat" deyince kurar. İnternet
yoksa uygulama normal çalışır; güncelleme zorunlu değildir. Durum Yardım ekranında görünür.

Yeni sürüm yayınlamak için:

1. `package.json` içindeki `version` değerini artır (ör. `1.0.1`).
2. GitHub token'ını ver ve yayınla:

```powershell
$env:GH_TOKEN = gh auth token
npm run release
```

Bu komut testleri çalıştırır, kurulum dosyasını derler ve `latest.yml` + `.blockmap` ile birlikte
GitHub'da yeni bir sürüm (release) olarak yayınlar. Kurulu uygulamalar bir sonraki açılışta
güncellemeyi bulur.

## Testler

Electron veya FFmpeg başlatmadan çalışan otomatik testler:

```powershell
npm test
```

Bu komut şunları doğrular:

- HTML/CSS/SVG bütünlüğü, tekil `id`'ler, renderer–HTML eşleşmesi ve UTF-8.
- Video filtre sırası (döndürme → çevirme → kırpma → ölçekleme), FFmpeg argümanları,
  kopya modu uygunluğu, ses stratejisi ve kapsayıcı seçimi.
- P3/CMYK renk profillerinin ve sRGB dönüşümünün görünümü bozmadığı.
- Fotoğrafta sıralı işlem hattı, EXIF/ICC koruma, 16-bit derinlik, yönlendirme
  (EXIF orientation), sınır dışı kırpma ve desteklenmeyen format reddi.
- GIF planı: klip süreleri, kesim/hız, merkezî kırpma, tuval normalizasyonu, palet filtresi,
  döngü argümanları, süre/kare sınırları ve güvenli çıktı adlandırma.
- Toplu işlem planı: video kopya/CRF/bit hızı seçimi, ses modu, güvenli yeniden boyutlandırma,
  fotoğraf formatı/uzun kenarı, GIF süre/kare sınırları ve dosya adı üretimi.
- Hedef boyut bütçesi ve iki geçiş argümanları, GPU kodlayıcı argümanları, çok bölümlü kesim
  ve birleştirme filtre grafikleri, metin katmanlarının ASS çıktısı, hazır ayar doğrulaması.
- Video oynatıcı: kare adımı, kesim sonundan oynatma, giriş/çıkış noktaları.
- Çeviri kapsamı: arayüzdeki her Türkçe metnin İngilizce karşılığı.

## Kalite notları

- **Kopya modunda kesim** anahtar kareye hizalanır; başlangıç/bitiş genelde 1–2 sn (bazen
  daha fazla) kayabilir. Bu, görüntünün yeniden kodlanmaması için bilinçli bir tercihtir.
  Kare hassasiyeti gerekiyorsa CRF modunu seç.
- **10-bit / HDR kaynaklar** için H.265 (veya VP9) önerilir. H.264 10-bit çıktısı her oynatıcıda
  desteklenmeyebilir.
- **ProRes** seçildiğinde ses, çoğu durumda PCM olarak yazılır; kapsayıcı MOV olur.
- **Fotoğrafta kayıpsız dışa aktarma** için PNG/TIFF/WebP (maksimum) seç veya orijinal formatı
  koru. JPEG seçildiğinde kalite %100'e kadar açılabilir.
- **Derin renk:** 16-bit kaynaklar PNG/TIFF'te 16-bit, AVIF'te 10-bit kalır; JPEG/WebP 8-bit'tir.
- **Fotoğraf modundaki GIF kaynaklar** düzenleme yapılmadığında birebir kopyalanır; düzenleme
  yapıldığında hareketsiz JPEG/PNG/WebP/AVIF/TIFF çıktısı üretilir.
- **GIF stüdyosu ses içermez ve 256 renkle sınırlıdır.** Renk geçişleri kaynak videodaki kadar
  pürüzsüz olmayabilir; dosya boyutu uzunluk, çözünürlük ve FPS ile hızla büyür. Varsayılan
  12 FPS ve 480 px genişlik dengeli bir başlangıçtır.
- GIF stüdyosu en fazla **60 saniye / 900 kare** üretir. Farklı en-boy oranlarındaki klipler
  tek tuvale sığdırılır; oran farkı siyah zeminle tamamlanır.
- GIF stüdyosu HDR (PQ/HLG) kaynakları Hable ton eşlemesiyle 8-bit SDR paletine aktarır.
  Kaynağa göre parlak alanlarda renk farkı yine de görülebilir.
- **Toplu video kuyruğunda varsayılan kayıpsız kopyadır.** Boyut sınırı seçilirse veya
  codec değiştirilirse dosya yeniden kodlanır; CRF modu otomatik devreye girer.
- **Toplu GIF kuyruğunda her medya ayrı GIF olur.** 60 saniye / 900 kare sınırı dosya
  bazındadır; sınırı aşan dosya hata olarak işaretlenir, kuyruktaki diğer dosyalar devam eder.
- **HEIC/HEIF desteklenmez:** Sharp'ın Windows paketinde HEVC kod çözücü bulunmadığı için
  bu dosyalar açılamaz; dosya seçicide de önerilmez.

## Kısayollar

| Tuş | İşlev |
| --- | --- |
| `Ctrl+O` | Dosya aç |
| `Space` | Oynat / durdur (GIF'te seçili video) |
| `←` / `→` | Videoda kare kare ilerle; GIF'te önceki/sonraki klip |
| `I` / `O` | Videoda giriş / çıkış noktasını oynatma konumuna koy |
| `B` | Seçili aralığı bölüm olarak ekle |
| `Ctrl+Z` | Fotoğrafta geri al |
| `Esc` | Kırpmayı iptal et / GIF önizlemesini kapat / toplu işlemi durdur |
| `F1` | Yardım |

## Proje yapısı

```
electron/   Ana süreç: IPC, medya sunucusu, FFmpeg ve Sharp işlemleri
src/        Arayüz: HTML, CSS ve düzenleyici mantığı (shared.js iki taraf için ortak)
assets/     Uygulama ikonları
scripts/    Paketleme yardımcıları (FFmpeg hazırlama)
test/       Electron/FFmpeg gerektirmeyen otomatik testler
```

## Çeviri

Arayüz Türkçe yazılır ve [src/i18n.js](src/i18n.js) Türkçe metni anahtar olarak kullanarak
İngilizceye çevirir. Yeni bir metin eklediğinde sözlüğe `'Türkçe': 'English'` satırını, sayı veya
ad içeren mesajlar için `EN_PATTERNS`'a bir desen ekle. `npm test` içindeki çeviri testi,
karşılığı olmayan Türkçe metinleri listeler. Yeni bir dil eklemek için `LANGUAGES` listesine ve
sözlüğe yeni bir bölüm eklemek yeterlidir.

## Lisans

Odak Studio, [GNU Genel Kamu Lisansı v3](LICENSE) veya (tercihinize göre) daha sonraki bir
sürümü altında dağıtılan özgür yazılımdır (`GPL-3.0-or-later`).

Kurulum paketi şu üçüncü taraf bileşenleri içerir; lisans metinleri kurulum klasöründe
`resources/licenses/` altındadır:

- **FFmpeg** (GPL v3 derleme, gyan.dev). Kaynak kodu ve derleme yapılandırması
  `FFMPEG-README.txt` içinde belirtilir.
- **Sharp / libvips** (Apache-2.0 / LGPL-3.0)
- **Electron / Chromium** (MIT ve Chromium lisansları; `LICENSES.chromium.html`)
