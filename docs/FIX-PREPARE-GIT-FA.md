# رفع توقف آماده‌سازی پس از ساخت imageها

این اصلاح برای نسخهٔ اولیهٔ ZIP نمایشی است که آماده‌سازی را با خطای زیر متوقف می‌کرد:

```text
all images built; now run: node infra/prepare/write-lock.mjs
Error: spawnSync git ENOENT
```

در نسخهٔ کامل مورخ ۲۰۲۶-۱۰-۲۶، این اصلاح از قبل یکپارچه است و ZIP اصلاحی جداگانه لازم نیست. لاگ بعدی مالک، اجرای موفق اصلاح و import/activation داده را تأیید کرده است؛ جزئیات در `VM_VALIDATION.md` آمده است. مراحل اعمال ZIP کوچک زیر برای بازیابی نسخهٔ اولیه نگهداری شده‌اند.

علت: مرحلهٔ نهایی داخل image ابزار عملیات اجرا می‌شد. این image، Node و Docker CLI دارد اما Git ندارد. ساخت imageها تمام شده، ولی فایل `infra/dependencies.lock.json` هنوز با شناسه‌های واقعی پر نشده است. در این وضعیت `expected=unknown` از `verify-images` به معنی ثبت‌نشدن شناسهٔ مورد انتظار است، نه حذف‌شدن imageها.

اصلاح، بررسی commitها را با Git موجود روی خود VM انجام می‌دهد و نتیجهٔ بررسی را همراه با hash فایل تنظیمات به ابزار Node داخل همان image موجود می‌دهد. ابزار داخل کانتینر مسیر سورس، hash تنظیمات و همهٔ commitهای مورد انتظار را کنترل می‌کند. هیچ شناسه‌ای از روی لاگ یا مقدار حدسی در lock قرار نمی‌گیرد؛ Docker همچنان شناسه‌های فعلی را روی همان VM inspect می‌کند.

## اعمال اصلاح روی VM فعلی

فایل `seyra-vm-demo-prepare-fix.zip` را در پوشهٔ home کاربر VM، مثلاً `/home/owner`، قرار دهید. ZIP فقط فایل‌های اصلاح آماده‌سازی و راهنما/آزمون آن را دارد؛ image، فایل داده، state یا فایل lock را جایگزین نمی‌کند.

```bash
cd "$HOME"
unzip -o seyra-vm-demo-prepare-fix.zip
cd "$HOME/seyra-vm-demo"
sha256sum -c PREPARE-FIX-SHA256SUMS
set -o pipefail
sudo bash scripts/finalize-preparation.sh 2>&1 | tee finalize.log
```

نیازی به اجرای مجدد `scripts/prepare.sh` و build موتورهای نقشه ندارید. این مرحله فقط checkoutهای موجود را کنترل می‌کند، فایل lock را تولید و شناسه‌های ده image ساخته‌شده را بررسی می‌کند. در پایان باید ده سطر `OK` و پیام `Preparation finalized` ببینید. مرحلهٔ finalize دسترسی شبکه نمی‌خواهد و چیزی نصب یا دانلود نمی‌کند.

اگر سورس‌ها را در مسیر دیگری نگه داشته‌اید:

```bash
sudo env SEYRA_SOURCES=/absolute/path/to/sources bash scripts/finalize-preparation.sh
```

بعد از موفقیت، برای بررسی سریع نصب:

```bash
sudo bash demo.sh --synthetic
```

یا برای فایل واقعی ثبت‌شده در لاگ شما:

```bash
sudo bash demo.sh --pbf /home/owner/data/iran-261017.osm.pbf
```

دستور بالا سرویس را به‌طور پیش‌فرض روی loopback اجرا می‌کند. پس از import و activation موفق، مسیرهای نقشه و Swagger داخل خود VM روی `http://127.0.0.1:8080/` و `http://127.0.0.1:8080/api/docs/` قرار دارند.

طبق محدودهٔ مجازی که مالک مشخص کرده (`172.16.20.*`)، دسترسی دمو را برای `172.16.20.0/24` باز کنید. برای اولین اجرای فایل واقعی در LAN:

```bash
sudo bash demo.sh --pbf /home/owner/data/iran-261017.osm.pbf \
  --bind 172.16.20.46 --cidrs 172.16.20.0/24 --port 8080
```

این دستور برای اولین اجرای داده در LAN است. اگر release قبلاً فعال است، روش تغییر access بدون import مجدد در `README-FA.md` آمده است.

پس از اجرای موفق، از کامپیوترهای مجاز این مسیرها را باز کنید:

- نقشه: `http://172.16.20.46:8080/`
- Swagger: `http://172.16.20.46:8080/api/docs/`
- سلامت: `http://172.16.20.46:8080/health/ready`

## دامنهٔ اعتبارسنجی اصلاح

هر ۶ آزمون رگرسیون موفق شدند. آزمون‌ها checkoutهای موقت واقعی با Git میزبان می‌سازند و مصرف‌کنندهٔ Node را با PATH خالی اجرا می‌کنند تا نبود Git در مرحلهٔ داخل کانتینر پوشش داده شود. تغییر تنظیمات، commit اشتباه، مسیر سورس متفاوت و رکورد ناقص رد می‌شوند. آزمون‌های syntax شل و Node نیز اجرا شده‌اند. لاگ بعدی مالک، اجرای واقعی و موفق finalize روی VM مقصد و تطبیق شناسهٔ هر ده image را تأیید کرده است.

هیچ تغییری در GitHub اعمال نشده است.
