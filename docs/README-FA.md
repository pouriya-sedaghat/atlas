# اجرای نمایشی Seyra روی VM

این بسته از سورس شاخهٔ `feat/map-services-v1` در commit زیر استخراج شده است:

`80935b42a9b5616c21df7483412c5fb2ccbc6df8`

شاخهٔ `main` در زمان استخراج فقط مستندات داشت. هیچ commit، push، branch، issue یا PR در GitHub ایجاد یا تغییر نکرده است. تغییرات فقط روی نسخهٔ محلی داخل این ZIP اعمال شده‌اند. فهرست فایل‌ها و تفاوت با منبع در `SOURCE.json` است.

این ZIP شامل سورس و ابزار آماده‌سازی است؛ imageهای ساخته‌شدهٔ Docker و دادهٔ واقعی نقشه در آن نیستند. با دسترسی اینترنت در مرحلهٔ آماده‌سازی، imageها از نسخه‌های مشخص‌شدهٔ پروژه ساخته می‌شوند. سرویس‌ها بعد از ساخت و import برای اجرا به اینترنت نیاز ندارند. اجرای کامل روی VM در محیط تهیهٔ این ZIP انجام نشده است؛ نتیجهٔ آزمون‌های واقعاً اجراشده در `VALIDATION.md` ثبت شده است.

## محتویات

| بخش | قابلیت |
| --- | --- |
| رابط نقشهٔ اصلی پروژه | MapLibre، فارسی/انگلیسی، حالت روشن/تیره، فونت و sprite محلی |
| Swagger UI و OpenAPI | مستندات تعاملی و ارسال درخواست به API همین VM |
| Tegola و PostGIS | کاشی برداری نقشه و فاصلهٔ مستقیم |
| Valhalla | مسیریابی، توقف‌های میانی و ترتیب بهینه در محدودهٔ قرارداد پروژه |
| Photon | جست‌وجو، autocomplete و reverse geocoding |
| Overpass | جست‌وجوی محدود POI |
| ابزار عملیات | import، اعتبارسنجی داده، start/stop، rollback، backup و recovery |

CA، PKI ویندوز، ساخت/امضای گواهی، ورود گواهی و بازیابی TLS حذف شده‌اند. این نسخه روی HTTP اجرا می‌شود. مرحلهٔ CA یا نصب root certificate ندارد. تنظیمات آماده‌سازی اختیاری `prep_ca` که در Dockerfileهای اصلی دیده می‌شود فقط مربوط به اعتماد اتصال خروجی محیط build است و CA برنامه را ایجاد یا اجرا نمی‌کند. محدودیت‌های منطقی درخواست و بررسی سلامت واقعی چهار سرویس حفظ شده‌اند. داده یا پاسخ ساختگی جایگزین خرابی سرویس‌ها نمی‌شود.

برای دمو با دادهٔ عمومی نقشه در شبکهٔ داخلی VM استفاده کنید. نام پروژه و شبکه‌های Docker با `seyra-demo` / `seyra_demo_` از اجرای اصلی جدا هستند. حتماً پوشهٔ state جدید استفاده کنید؛ state یا lockهای نسخهٔ اصلی را روی این نسخه کپی نکنید. پورت داخلی proxy به‌علت سازگاری ابزار اصلی 8443 است اما پروتکل آن HTTP و پورت میزبان پیش‌فرض 8080 است. نام داخلی قدیمی `SEYRA_HTTPS_PORT`/`httpsPort` هم فقط نام کلید پورت است و TLS را فعال نمی‌کند.

## ۱. پیش‌نیاز VM

Ubuntu/Debian با معماری `amd64` و Docker Engine همراه Compose و Buildx لازم است. راهنمای رسمی نصب: [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)، [Debian](https://docs.docker.com/engine/install/debian/).

پس از نصب Docker، این دستورها باید موفق باشند؛ کاربری که اسکریپت را اجرا می‌کند باید به daemon دسترسی داشته باشد:

```bash
docker info
docker compose version
docker buildx version
sudo apt-get update
sudo apt-get install -y git curl python3 unzip ca-certificates
```

برای اولین آزمایش با دادهٔ کوچک، ۴ هسته و حدود ۸ گیگابایت RAM نقطهٔ شروع پیشنهادی است؛ تضمین ظرفیت نیست. ساخت اولیهٔ چند موتور از سورس زمان و فضای قابل توجهی می‌گیرد. فضای Docker را علاوه بر فضای داده در نظر بگیرید. برای کل ایران باید فضای staging و indexها و محدودیت فضای importer را مطابق فایل ورودی بسنجید؛ مقدار پیش‌فرض عامل فضا از سورس اصلی حفظ شده است. برای ارائهٔ سریع می‌توانید فایل واقعی یک محدودهٔ کوچک‌تر از شهر را وارد کنید. این ZIP کل ایران را به‌صورت آماده در اختیار ندارد.

## ۲. انتقال و ساخت اولیه با اینترنت

```bash
unzip seyra-vm-demo.zip
cd seyra-vm-demo
sha256sum -c SHA256SUMS
bash scripts/prepare.sh 2>&1 | tee prepare.log
```

`prepare.sh` سورس‌های قفل‌شده، JAR و wheel را دریافت و checksum آنها را کنترل می‌کند؛ سپس همهٔ imageهای لازم را می‌سازد و lock جدید را با شناسه‌های واقعاً ساخته‌شده می‌نویسد. اینترنت این مرحله باید به GitHub، Docker Hub، npm، PyPI و مخازن بسته‌های استفاده‌شده در Dockerfileها دسترسی داشته باشد. Node روی میزبان نصب نمی‌شود؛ نسخهٔ لازم در imageهای پروژه است.

`infra/upstream.dependencies.lock.json` فقط سند نسخهٔ اصلی است؛ image IDهای آن به‌عنوان imageهای این بسته جا زده نشده‌اند. `infra/dependencies.lock.json` داخل ZIP عمداً قالب «ساخته‌نشده» است. تا پایان موفق آماده‌سازی و بازنویسی lock، اجرای دمو متوقف می‌شود. برای ادامهٔ آماده‌سازی ناموفق، علت شبکه/build را رفع و همان دستور را دوباره اجرا کنید؛ cacheهای build حفظ می‌شوند.

`SHA256SUMS` محتویات ZIP را پیش از اولین اجرا تأیید می‌کند. آماده‌سازی عمداً lock و فایل‌های خروجی را تغییر می‌دهد؛ پس از آن تطبیق مجدد کل پوشه با checksum اولیه انتظار نمی‌رود.

اگر گام build به‌علت شبکهٔ bridge در npm timeout شد، مقدار `SEYRA_BUILD_NETWORK=host` را برای آماده‌سازی تعیین کنید؛ این فقط شبکهٔ build را تغییر می‌دهد:

```bash
SEYRA_BUILD_NETWORK=host bash scripts/prepare.sh
```

برای ثبت exit code دقیق هنگام ذخیرهٔ log با pipe، پیش از دستور `set -o pipefail` اجرا کنید.

اگر نسخهٔ اولیهٔ ZIP را قبلاً اجرا کرده‌اید و پس از پیام `all images built` به خطای `spawnSync git ENOENT` رسیده‌اید، imageها ساخته شده‌اند. اصلاح این مرحله و ادامهٔ آماده‌سازی بدون build مجدد در [FIX-PREPARE-GIT-FA.md](FIX-PREPARE-GIT-FA.md) آمده است. در نسخهٔ اصلاح‌شده، `prepare.sh` خودش مرحلهٔ نهایی اصلاح‌شده را فراخوانی می‌کند.

## ۳. اجرای نقشهٔ واقعی برای ارائه

فایل `.osm.pbf` منطقهٔ مورد نظر را خودتان روی VM قرار دهید. اسکریپت آن را از اینترنت دانلود نمی‌کند و فایل اصلی شما را حذف یا بازنویسی نمی‌کند.

```bash
bash demo.sh --pbf /home/your-user/maps/region.osm.pbf
```

این دستور ابتدا دیتابیس را آماده می‌کند، داده را در هر چهار سرویس import و در staging اعتبارسنجی می‌کند، release را فعال می‌کند و HTTP smoke را اجرا می‌کند. زمان import به داده و سخت‌افزار بستگی دارد.

آدرس‌ها داخل VM:

- نقشه: `http://127.0.0.1:8080/`
- Swagger: `http://127.0.0.1:8080/api/docs/`
- OpenAPI: `http://127.0.0.1:8080/api/docs/json`
- سلامت همهٔ سرویس‌ها: `http://127.0.0.1:8080/health/ready`

اگر هیچ فایل واقعی ندارید، فقط برای آزمایش مسیر نصب می‌توانید نمونهٔ مصنوعی اصلی پروژه را اجرا کنید:

```bash
bash demo.sh --synthetic
```

این نمونه شامل خیابان‌ها و نام‌های خیالی در نزدیکی طول/عرض صفر است؛ نقشهٔ ایران نیست. رابط به محدودهٔ دادهٔ فعال می‌رود. برای نمایش جغرافیای واقعی به کارفرما، فایل واقعی وارد کنید.

## ۴. باز کردن روی کامپیوتر کارفرما در LAN

مثال زیر را با IP واقعی VM و subnet واقعی دستگاه‌های مجاز جایگزین کنید. VM باید از دستگاه کارفرما از طریق تنظیمات شبکهٔ VM قابل دسترس باشد. در حالت NAT ممکن است به port forwarding در نرم‌افزار مجازی‌سازی نیاز باشد.

```bash
bash demo.sh --pbf /home/your-user/maps/region.osm.pbf \
  --bind 192.168.1.50 --cidrs 192.168.1.0/24 --port 8080
```

در مرورگر کارفرما:

```text
http://192.168.1.50:8080/
http://192.168.1.50:8080/api/docs/
```

نیازی به CA، گواهی یا trust در مرورگر نیست. فیلتر CIDR برای دسترسی شبکه است و login کاربر نیست. نمونهٔ بالا خود VM را هم در subnet مجاز قرار می‌دهد تا smoke محلی اجرا شود. اگر فقط IP کارفرما را با `/32` مجاز می‌کنید، آزمون HTTP را از همان دستگاه مجاز اجرا کنید. برای hostname داخلی از `--server-names "192.168.1.50 maps.internal"` استفاده و نام را در DNS/hosts خودتان resolve کنید؛ نام ناشناخته پاسخ 421 می‌گیرد.

اگر داده قبلاً فعال است و فقط می‌خواهید bind/CIDR را تغییر دهید، import مجدد لازم نیست:

```bash
export SEYRA_HOME="$PWD/.demo-state"
bash bin/seyra-maps init --bind 192.168.1.50 --port 8080 --access lan \
  --lan-cidrs 192.168.1.0/24 --server-names "localhost 127.0.0.1 192.168.1.50" --no-relay
bash bin/seyra-maps access apply
bash bin/seyra-maps proxy restart
bash scripts/smoke.sh http://192.168.1.50:8080
```

## ۵. کنترل پیش از ارائه و استفاده‌های بعدی

```bash
export SEYRA_HOME="$PWD/.demo-state"
bash bin/seyra-maps status
bash scripts/smoke.sh http://127.0.0.1:8080
bash bin/seyra-maps stop
bash bin/seyra-maps start
```

در LAN آدرس smoke را با IP VM جایگزین کنید. `start` دادهٔ فعال قبلی را اجرا می‌کند و import دوباره انجام نمی‌دهد. در مرورگر نقشه را بررسی کنید، حالت فارسی/انگلیسی و روشن/تیره را عوض کنید، یک جست‌وجو و مسیر داخل محدودهٔ داده انجام دهید و یک درخواست Swagger را با Try it out بفرستید. فقط وقتی `/health/ready` کد 200 می‌دهد همهٔ سرویس‌ها آماده‌اند. 503 را به‌عنوان اجرای سالم ارائه نکنید.

state پیش‌فرض در `.demo-state`، log import در `validation/` و logهای ریز import در state ذخیره می‌شوند. کانتینرها از پروژهٔ `seyra-demo` هستند:

```bash
docker ps --filter label=com.docker.compose.project=seyra-demo
docker logs seyra-demo-api-1
docker logs seyra-demo-proxy-1
```

در صورت قطع import یا activation، پوشه‌های state را دستی پاک نکنید؛ پیام ابزار، `status` و در صورت درخواست ابزار `recover` را دنبال کنید. برای استفاده از مسیر state دلخواه، همان `SEYRA_HOME` مطلق را در همهٔ دستورها تعیین کنید. این بسته محدودیت‌های منابع و درخواستِ سورس را حفظ کرده است؛ درخواست خارج از محدوده یا ترکیب پشتیبانی‌نشده عمداً خطای تایپ‌شده می‌دهد.

## ۶. انتقال اختیاری پس از ساخت به VM دیگر بدون اینترنت

پس از آماده‌سازی موفق روی لینوکس، ابزار اصلی می‌تواند imageها را همراه فایل‌های نصب export کند:

```bash
export SEYRA_HOME="$PWD/.demo-state"
bash bin/seyra-maps bundle export --out /absolute/path/to/new-empty-offline-bundle
```

این خروجی با ZIP سورس فعلی فرق دارد و ممکن است بزرگ باشد. فایل دادهٔ واقعی و state/secretها به‌صورت پیش‌فرض در آن قرار نمی‌گیرند. روی مقصد checksumها را بررسی کنید، سپس از `install/bin/seyra-maps bootstrap-load /absolute/path/to/bundle` imageها را load کنید و از داخل `install/` با state جدید و فایل دادهٔ محلی دمو را اجرا کنید. این مسیر export/load در محیط تهیهٔ ZIP حاضر آزمایش نشده است.

مجوزها و انتساب OSM و اجزای ثالث در `LICENSES.md` حفظ شده‌اند. راهنمای mobile قدیمی صرفاً مرجع قرارداد اصلی است؛ توضیحات TLS در آن مربوط به نسخهٔ اصلی هستند و برای اجرای این دمو از همین راهنما استفاده کنید.
