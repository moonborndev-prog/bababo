# BaBaBo Quiz

Kahoot tarzı canlı yarışma sitesi. Soruları kendi panelinden hazırlarsın, takımlar telefonlarından PIN kodu ya da QR ile girer, puanlar anlık olarak hesaplanır ve skor tablosu ekrana yansır.

Öne çıkanlar: her soruya ayrı puan değeri girebilirsin (10, 50, 250, ne istersen), çoktan seçmelinin yanında boşluk doldurma soruları sorabilirsin, 80 ve üzeri eşzamanlı katılımcıyı rahat kaldırır. Bekleme ekranında katılan takımlar herkesin telefonunda canlı olarak listelenir. Skor tablosu her soru sonrasında önce eski sıralamayı gösterir, kazanılan puanlar rozet olarak düşer, skorlar sayarak artar ve satırlar yeni sırasına animasyonla kayar. Oyun sonunda podyum ve tam sıralama gelir.

## Bilgisayarında çalıştırmak (2 dakika)

Node.js 18 veya üzeri kurulu olmalı (nodejs.org).

```
npm install
npm start
```

Açılan adresler:

- Oyuncular için: `http://localhost:3000`
- Yönetim paneli: `http://localhost:3000/host` (varsayılan şifre: `quiz123`)

Aynı Wi-Fi ağındaki telefonlar, bilgisayarının yerel IP adresiyle bağlanır (örn. `http://192.168.1.20:3000`). IP adresini Windows'ta `ipconfig`, Mac'te `ifconfig` ile görebilirsin. Okul ve şirket ağlarında cihazlar arası erişim bazen kapalı olur; etkinlikten önce bir telefonla denemekte fayda var.

## İnternete açmak (Render, ücretsiz)

Render'ın ücretsiz planı bu iş için yeterli. Kart bilgisi istemez.

1. Bu klasörü bir GitHub deposuna yükle (github.com üzerinde "New repository" de, dosyaları sürükleyip bırakabilirsin; `node_modules` klasörünü yükleme).
2. render.com'a GitHub hesabınla gir, "New +" > "Web Service" de ve depoyu seç.
3. Ayarlar: Build Command `npm install`, Start Command `npm start`, Instance Type `Free`.
4. "Environment" bölümüne `ADMIN_PASSWORD` adında bir değişken ekle ve kendi şifreni yaz. Bunu yapmazsan şifre `quiz123` kalır, internete açık bir sitede mutlaka değiştir.
5. Deploy bitince sana `https://xxxx.onrender.com` gibi bir adres verir. Oyuncular bu adrese, sen `https://xxxx.onrender.com/host` adresine girersin.

Ücretsiz planla ilgili iki not: Servis 15 dakika boş kalınca uykuya geçer ve ilk girişte uyanması yaklaşık bir dakika sürer, bu yüzden etkinlikten 10-15 dakika önce siteyi bir kez aç. Bir de ücretsiz makine küçüktür ama 80 kişilik bir oyun için fazlasıyla yeterli.

## Nasıl kullanılır

1. `/host` adresine gir, şifreni yaz.
2. "Örnek Quiz" ile hemen deneyebilir ya da "Yeni Quiz" ile kendi sorularını hazırlayabilirsin. Her soruda puanı ve süreyi ayrı ayrı belirlersin (süreye 0 yazarsan sen kapatana kadar açık kalır).
3. Boşluk doldurma sorularında kabul edilen cevapları alt alta yazarsın. Büyük/küçük harf ve fazla boşluklar önemsenmez, istersen "1 harflik yazım hatasını kabul et" seçeneğini de açarsın. Türkçe karakterler (İ/ı dahil) doğru işlenir.
4. "Başlat" deyince ekrana PIN ve QR kodu gelir. Bu ekranı projeksiyona yansıt, katılımcılar telefonlarından girsin.
5. Soruları sen ilerletirsin: soru açılır, herkes cevaplayınca ya da süre bitince kapanır, doğru cevap ve cevap dağılımı ekrana gelir, ardından skor tablosunu gösterip sonraki soruya geçersin.
6. Oyun sonunda podyum ve tüm sıralama görünür, sonuçları CSV olarak indirebilirsin.

## Bilinmesi gerekenler

- Quizler, host panelini açtığın tarayıcıda saklanır. Başka bir bilgisayardan sunacaksan quizi "İndir" ile JSON olarak alıp orada "İçe Aktar" ile yükle. Önemli quizlerin yedeğini almak için de aynı yöntemi kullan.
- Bağlantısı kopan ya da sayfayı yenileyen takım, puanı korunmuş şekilde kaldığı yerden devam eder. Telefon veya tarayıcı tamamen değişse bile aynı takım adıyla tekrar girmek yeterlidir; skor geri gelir. Ad çalınmasın diye bu yalnızca bağlantısı kopuk takımlar için çalışır, bağlı bir takımın adıyla ikinci kişi giremez.
- Skorlar sunucunun belleğinde tutulur. GitHub'a dosya yüklemek Render'da yeniden deploy başlatır ve o anda açık olan oyunları sıfırlar; canlı oyun sırasında güncelleme yükleme.
- Host ekranında sayfayı yanlışlıkla yenilersen oyun bozulmaz, kaldığı yerden devam edersin.
- Aynı takım adını ikinci bir kişi alamaz. Lobide bir ismin yanındaki çarpıya basarak o takımı çıkarabilirsin.
- Doğru cevaplar oyunculara hiçbir aşamada gönderilmez, puanlama tamamen sunucuda yapılır. Yani tarayıcı konsolunu açan kurnaz bir katılımcı doğru cevabı göremez.
- Geri sayımın son 5 saniyesinde host ekranı bip sesi çalar, sağ üstten kapatabilirsin.

## Testler

`tools/simulate.js` dosyası 85 sanal oyuncuyla tam bir oyun oynayıp puanlamayı, boşluk doldurma eşleştirmesini ve yeniden bağlanmayı kontrol eder. Merak edersen sunucu açıkken `SIM_URL=http://localhost:3000 node tools/simulate.js` ile çalıştırabilirsin.
