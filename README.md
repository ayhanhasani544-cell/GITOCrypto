# Cloudflare USDT Wallet Worker

این Worker نسخه Cloudflare از Backend کیف پول است و به Turso از طریق HTTPS وصل می‌شود. توکن Turso داخل فایل نیست.

## 1. نصب روی Termux یا کامپیوتر

```bash
pkg install nodejs git -y
unzip CloudflareUSDTWorker.zip
cd CloudflareUSDTWorker
npm install
npx wrangler login
```

## 2. تنظیم URL دیتابیس

در `wrangler.toml` مقدار `TURSO_DATABASE_URL` را با URL HTTPS دیتابیس خودت تنظیم کن. برای Cloudflare از `https://` استفاده کن، نه `libsql://`.

## 3. ساخت Secretها

این دستورها را اجرا کن و مقدارها را در صفحه ترمینال وارد کن. Secretها را داخل فایل یا App Inventor قرار نده:

```bash
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put API_KEY
npx wrangler secret put ADMIN_INGEST_KEY
```

`API_KEY` برای درخواست‌های معمولی اپلیکیشن است. `ADMIN_INGEST_KEY` فقط برای endpoint درآمد و فقط باید توسط سرویس تأییدکننده تبلیغ/مأموریت استفاده شود.

## 4. Deploy

```bash
npx wrangler deploy
```

خروجی یک آدرس شبیه این می‌دهد:

```text
https://usdt-wallet-worker.<account>.workers.dev
```

در App Inventor همین آدرس را در `SetApiUrl` قرار بده. آدرس Turso، Token یا Secret را در APK قرار نده.

## 5. تست سلامت

```bash
curl https://usdt-wallet-worker.<account>.workers.dev/health
```

## 6. ساخت کاربر

```bash
curl -X POST 'https://usdt-wallet-worker.<account>.workers.dev/api/user/create' \
  -H 'content-type: application/json' \
  -H 'x-api-key: API_KEY' \
  -d '{"userId":"demo123"}'
```

سپس در App Inventor:

```text
SetApiUrl = https://usdt-wallet-worker.<account>.workers.dev
SetUserId = demo123
```

## نکته درباره درآمد

`/api/earn` عمداً با API key معمولی باز نمی‌شود. فقط درخواست دارای `x-admin-key` پذیرفته می‌شود و `providerEventId` باید یکتا باشد؛ بنابراین کاربر نمی‌تواند با تغییر APK موجودی را زیاد کند. در حالت تست Appodeal، درآمد USDT ثبت نکن.

## هشدار پرداخت

این Worker فعلاً برداشت را با وضعیت `pending` ثبت می‌کند. برای پرداخت واقعی باید یک Worker/صف امن و Payment Provider تأییدشده اضافه شود. Private Key یا Seed Phrase هرگز در Worker source، AIX یا APK قرار نگیرد.
