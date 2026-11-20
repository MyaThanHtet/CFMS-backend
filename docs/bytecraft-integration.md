# CFMS × ByteCraft — Account, plans and offline access

CFMS မှာ ByteCraft account တစ်ခုတည်းနဲ့ Sign in / Sign up လုပ်ပါတယ်။ CFMS password form၊ သီးခြား registration နဲ့ Google sign-in endpoint တွေကို production app က မသုံးတော့ပါဘူး။ Mobile က system browser မှာ ByteCraft hosted account စာမျက်နှာကို ဖွင့်ပြီး Authorization Code + PKCE နဲ့ ပြန်ဝင်ပါတယ်။

## အသုံးပြုသူ flow

1. **Sign in with ByteCraft** သို့မဟုတ် **Create a ByteCraft account** ကို နှိပ်ပါ။ Account အသစ်ဖွင့်တဲ့အခါ ByteCraft hosted signup ကို ပြပါတယ်။ Hosted sign-in link သည် ၁၅ မိနစ်အကြာတွင် သက်တမ်းကုန်နိုင်ပါတယ်။ Registration တင်ပြီးနောက် `Link expired` ပေါ်လာပါက account ဖန်တီးပြီးသား ဖြစ်နိုင်တာကြောင့် CFMS သို့ပြန်ပြီး **Sign in with ByteCraft** ကိုရွေးပါ၊ account အသစ် ထပ်မဖွင့်ပါနှင့်။
2. Login ပြီးလျှင် subscription ဝယ်ရန် မလိုဘဲ local shop တစ်ခု ဖန်တီးနိုင်ပါတယ်။
3. Free မှာ category ၃ ခု၊ item ၅ ခု၊ contact ၅ ခုအထိ offline စမ်းသုံးနိုင်ပါတယ်။ Units, expenses, sales, purchases, cash accounts, shop payment methods တို့ကိုလည်း တစ်မျိုးစီ ၅ ခု ကန့်သတ်ထားပါတယ်။ အစမှာ ဖန်တီးပေးတဲ့ Cash drawer / Cash method က သက်ဆိုင်ရာ limit ထဲ ပါပါတယ်။ Categories က item/contact/expense categories စုစုပေါင်း ၃ ခု ဖြစ်ပါတယ်။
4. အပေါ်ဘက်က **Free · Offline only** badge သို့မဟုတ် Settings → **Plans & subscription** မှာ တကယ့် ByteCraft plans တွေကို ကြည့်နိုင်ပါတယ်။
5. Plan ရွေး၊ တကယ့် payment account ကို ကြည့်၊ ငွေလွှဲ၊ transaction ID နဲ့ screenshot တင်ပါ။ Request က pending ဖြစ်နေချိန်မှာ paid access မပေးသေးပါဘူး။ Finance admin approve လုပ်ပြီးမှ paid tier / cloud sync ရပါတယ်။
6. **Cancel at period end** လုပ်လျှင် ပေးချေထားတဲ့ သက်တမ်းကုန်တဲ့အထိ paid features / sync ဆက်သုံးနိုင်ပါတယ်။ Expiry မတိုင်ခင် **Keep plan** နဲ့ cancellation ပြန်ပယ်ဖျက်နိုင်ပါတယ်။ Manual prepaid billing ဖြစ်တဲ့အတွက် automatic charge မရှိပါဘူး။ နောက်ထပ် payment ကို approve လုပ်ပါက cancellation flag ပြန်ရှင်းပါတယ်။
7. Expiry ပြီးလျှင် Free/offline ပြန်ပြောင်းပါတယ်။ ရှိပြီးသား local/cloud records တွေကို မဖျက်ပါဘူး။ Free limit ထက် records ပိုနေပါက အသစ်ထပ်ထည့်ခြင်းကို ပိတ်ထားပါတယ်။

Free က identity / plan / billing metadata ကို online ဖတ်နိုင်ပါတယ်။ **Shop/business data ကို server သို့ sync မလုပ်နိုင်ပါဘူး။** CFMS backend ကို တိုက်ရိုက်ခေါ်လည်း paid cloud entitlement မရှိရင် HTTP 402 ပြန်ပါတယ်။

## Local development — အစမှ ပြင်ဆင်ရန်

လိုအပ်ချက်: Node.js 22.13+, npm, Docker Desktop, Flutter, Android SDK / Xcode။ အောက်ပါ commands များက existing databases ကို reset မလုပ်ပါဘူး။ `.env` ဖိုင်များကို commit မလုပ်ပါနဲ့။

### 1. ByteCraft Platform backend

```bash
cd /Users/mac/MyProjects/ByteCraft-Platform/bytecraft-platform-backend
npm ci
# .env မရှိသေးလျှင်သာ .env.example ကို copy ပြီး database/keys ပြင်ပါ။
npm run db:up
npm run db:deploy
npm run build
```

Existing Platform `.env` ထဲက encryption keys ကို ဆက်သုံးပါ။ Fresh setup အတွက် Platform README ရဲ့ `admin:key`, `platform:key`, staff bootstrap နဲ့ SMTP setup ကို လိုက်လုပ်ပါ။ Hosted signup က email verification လိုတဲ့အတွက် local mail ကို ကြည့်နိုင်ရန်:

```bash
npm run mail:up
```

Platform `.env` မှာ local SMTP အတွက် `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `EMAIL_WORKER_ENABLED=true` ပြင်ပြီး API ပြန်စပါ။ Inbox က `http://localhost:8025` ဖြစ်ပါတယ်။ Verification message ထဲက link ကို browser မှာ ဖွင့်ပါ။

### 2. CFMS database နဲ့ native OAuth clients

```bash
cd /Users/mac/MyProjects/CFMS/cfms-backend
npm ci
# .env မရှိသေးလျှင်သာ:
# cp .env.example .env
npm run prisma:generate
docker compose up -d --wait postgres
npm run db:migrate
npm run platform:configure:local
```

`platform:configure:local` က local Platform database ထဲမှာ တကယ့် `cfms` Application၊ Android/iOS public native OAuth clients နဲ့ signed webhook destination ဖန်တီးပါတယ်။ Run ထပ်လုပ်လည်း clients / endpoint အသစ်တွေ ထပ်မပွားပါဘူး။ Secrets ကို CFMS `.env` ထဲမှာပဲ သိမ်းပြီး terminal မှာ မပြပါဘူး။ Platform `.env` ကို `WEBHOOK_ALLOW_PRIVATE=true` ပြင်ပေးပါတယ်။ Local loopback database ကိုသာ helper က လက်ခံပါတယ်။ Plans, prices, payment accounts သို့မဟုတ် customers မဖန်တီးပါဘူး။

Default sibling path မတူလျှင်:

```bash
BYTECRAFT_PLATFORM_DIR=/absolute/path/bytecraft-platform-backend npm run platform:configure:local
```

Database port mapping ကို `.env` ရဲ့ `POSTGRES_PORT` နဲ့ `DATABASE_URL` တူအောင်ထားပါ။ CFMS `.env.example` default က 5432 ဖြစ်ပါတယ်။ ဒီ workspace ရဲ့ existing CFMS development configuration က 5434 ကို သုံးထားပါတယ်။ Platform dev database က 5433၊ Platform disposable test database က 5434 ဖြစ်လို့ **Platform test container နဲ့ CFMS development database ကို 5434 ပေါ်မှာ တစ်ပြိုင်တည်း မဖွင့်ပါနဲ့**။ Container/volume မဖျက်ဘဲ test container ကို stop လုပ်နိုင်ပါတယ်။

### 3. API နှစ်ခု စရန် — terminal သီးခြားစီ

```bash
cd /Users/mac/MyProjects/ByteCraft-Platform/bytecraft-platform-backend
npm run start:dev
```

```bash
cd /Users/mac/MyProjects/CFMS/cfms-backend
npm run dev
```

| Service                        | URL                                         |
| ------------------------------ | ------------------------------------------- |
| Platform API / OAuth issuer    | `http://localhost:3000`                     |
| CFMS API                       | `http://localhost:4000`                     |
| CFMS public integration config | `http://localhost:4000/v1/platform/config`  |
| CFMS health                    | `http://localhost:4000/health`              |
| Platform webhook destination   | `http://localhost:4000/v1/platform/webhook` |
| Native OAuth callback          | `com.cfms.mobile:/oauth2redirect`           |

Platform webhook worker ကို default embedded worker အဖြစ် ဖွင့်ထားပါ။ `WEBHOOK_WORKER_ENABLED=false` ရှိလျှင် `true` ပြောင်းပြီး restart လုပ်ပါ၊ သို့မဟုတ် standalone `npm run start:worker` သုံးပါ။

### 4. Mobile စရန်

```bash
cd /Users/mac/MyProjects/CFMS/cfms-mobile
flutter pub get
```

Android emulator အတွက် issuer ရဲ့ canonical `localhost:3000` ကို device မှာ ရောက်နိုင်ရန် emulator ချိတ်ပြီး:

```bash
adb reverse tcp:3000 tcp:3000
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000
```

Browser၊ discovery၊ JWKS နဲ့ token issuer တို့က **issuer တစ်ခုတည်း အတိအကျ** သုံးရပါတယ်။ `localhost` ကို OAuth request တစ်နေရာမှာ `10.0.2.2` နဲ့ အစားမထိုးပါနဲ့။ Android debug manifest က local HTTP ကို ခွင့်ပြုထားပြီး release sign-in က HTTPS ကို လိုအပ်ပါတယ်။

iOS simulator:

```bash
flutter run --dart-define=API_BASE_URL=http://127.0.0.1:4000
```

Android physical device ကို USB နဲ့ local စမ်းလျှင်:

```bash
adb reverse tcp:3000 tcp:3000
adb reverse tcp:4000 tcp:4000
flutter run --dart-define=API_BASE_URL=http://localhost:4000
```

Production / physical iOS အတွက် device နဲ့ CFMS server နှစ်ခုလုံးက ရောက်နိုင်တဲ့ HTTPS Platform issuer နဲ့ HTTPS CFMS API ကို သုံးပါ။ iOS deployment target က 15.0 ဖြစ်ပါတယ်။ Android/iOS callback scheme ကို native configuration ထဲမှာ ထည့်ထားပြီးဖြစ်ပါတယ်။

## Back Office မှာ တကယ့် plans / receiving accounts ပြင်ရန်

Back Office မှာ `CFMS` application ရှိတာစစ်ပြီး `Apps & Plans` → application `cfms` အောက်မှာ ကိုယ့်ရဲ့ စျေးနှုန်း၊ သက်တမ်းနဲ့ active plans ဖန်တီးပါ။ Payment Settings မှာ တကယ့် bank / wallet account နဲ့ QR ထည့်ပါ။ Mobile က `GET /api/v1/plans?app=cfms` နဲ့ `GET /api/v1/payment-methods` ကို ဖတ်ပါတယ်။ Data မရှိသေးရင် empty state ပြပြီး sample plan/account အစားမထိုးပါဘူး။

Entitlements ဥပမာ — **အမှန်တကယ် ရောင်းချလိုတဲ့ tier အလိုက် ပြင်ပါ**:

```json
{
  "cloud_sync": true,
  "max_shops": 1,
  "max_categories": 50,
  "max_items": 1000,
  "max_contacts": 1000,
  "max_units": 100,
  "max_expenses": 10000,
  "max_sales": 10000,
  "max_purchases": 10000,
  "max_cash_accounts": 20,
  "max_payment_methods": 20
}
```

Limits က nonnegative integer ဖြစ်ပြီး paid plan မှာ မပါရင် အဲဒီ resource ကို unlimited လို့ သတ်မှတ်ပါတယ်။ `cloud_sync=false` သို့မဟုတ် `sync_enabled=false` ဆို paid ဖြစ်လည်း sync ပိတ်ပါတယ်။ CFMS mobile ရဲ့ SQLite working shop architecture က လက်ရှိ account တစ်ခုမှာ local working shop တစ်ခုကိုပဲ တစ်ချိန်တည်း ဖွင့်ထားပါတယ်။

## Production configuration

Local helper ကို production မှာ မသုံးပါနဲ့။ Back Office မှာ `cfms` Application ကိုဖန်တီးပြီး Android/iOS အတွက် **public native** clients ကို သီးခြား register လုပ်ပါ။ Redirect URI က `com.cfms.mobile:/oauth2redirect`၊ allowed scopes က `openid profile email offline_access platform` ဖြစ်ပါတယ်။ Native app ထဲမှာ client secret မထည့်ပါနဲ့။

CFMS backend environment:

```ini
PORT=4000
DATABASE_URL=postgresql://...
BYTECRAFT_ISSUER=https://platform.bytecraft.com
BYTECRAFT_APP_CODE=cfms
BYTECRAFT_CLIENT_IDS=REAL_ANDROID_CLIENT_ID,REAL_IOS_CLIENT_ID
BYTECRAFT_ANDROID_CLIENT_ID=REAL_ANDROID_CLIENT_ID
BYTECRAFT_IOS_CLIENT_ID=REAL_IOS_CLIENT_ID
BYTECRAFT_REDIRECT_URI=com.cfms.mobile:/oauth2redirect
BYTECRAFT_WEBHOOK_CLIENT_ID=REAL_DESTINATION_CLIENT_ID
BYTECRAFT_WEBHOOK_SECRET=SERVER_ONLY_WEBHOOK_SECRET
```

Platform မှာ Application `cfms` အတွက် `https://YOUR_CFMS_API/v1/platform/webhook` ကို register လုပ်ပါ။ Destination ကို Android native client နဲ့ map လုပ်ထားနိုင်ပါတယ်။ Android/iOS နှစ်ခုလုံး Application တူရင် subscription တစ်ခုတည်းကို သုံးပါတယ်။ `BYTECRAFT_WEBHOOK_CLIENT_ID` က destination နဲ့ map ထားတဲ့ client ID ဖြစ်ရပါမယ်။ Secret ကို mobile / public config ထဲ မထည့်ပါနဲ့။ Production Platform မှာ private-IP webhook allowance ပိတ်ထားပါ။

Compose `api` container သုံးလျှင် `localhost` က container ကိုယ်တိုင်ကို ဆိုလိုပါတယ်။ Host မှာ run တဲ့ Platform ကို container က ချိတ်ရာမှာ device/browser နဲ့ပါ ရောက်နိုင်တဲ့ canonical HTTPS issuer သုံးပါ။ Local walkthrough က APIs နှစ်ခုကို host terminals မှာ run ဖို့ ရေးထားတာဖြစ်ပါတယ်။

## Implemented endpoints / security

| Endpoint                                        | Access / purpose                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /v1/platform/config`                       | Public issuer / native client identifiers; secrets မပါ                        |
| `GET /v1/auth/bytecraft/me`                     | ByteCraft bearer; CFMS-local mapped profile ID                                |
| `GET /v1/platform/access`                       | ByteCraft bearer; authoritative subscription reconciliation + tier/limits     |
| `POST /v1/platform/reconcile`                   | Same-account bearer + `{ "accessToken": "..." }`; reconciliation              |
| `POST /v1/platform/webhook`                     | Raw body HMAC SHA256, 5-minute replay window, event ID dedupe                 |
| `/v1/stores`, commands / changes / snapshots    | ByteCraft bearer + current paid cloud access, transactional plan quota checks |
| Platform `POST /api/v1/subscriptions/me/cancel` | Tenant OWNER/ADMIN; cancel at paid period end                                 |
| Platform `POST /api/v1/subscriptions/me/resume` | Tenant OWNER/ADMIN; withdraw scheduled cancellation                           |

CFMS verifies RS256 signature, issuer, expiry, audience, `typ=at+jwt`, native client allowlist, `platform` scope နဲ့ central `auth/me` ရဲ့ customer/tenant status ကို စစ်ပါတယ်။ Admin/customer identities မရောပါဘူး။ Business sync request တိုင်း caller ရဲ့ ByteCraft token နဲ့ current subscription ကို reconcile လုပ်ပြီးမှ cloud entitlement ကို စစ်ပါတယ်။ Webhook နောက်ကျနေချိန်မှာ mobile access endpoint ကို မခေါ်ဘဲ stale cloud permission ဆက်သုံးလို့ မရပါဘူး။ Business sync က Free အတွက် fail closed ဖြစ်ပါတယ်။ Webhook က signed raw bytes ကိုစစ်၊ event ID ကို transaction ထဲမှာ dedupe လုပ်ပြီး subscription version အဟောင်းနဲ့ current state ကို overwrite မလုပ်ပါဘူး။ REST reconciliation က webhook လွတ်သွားရင် ပြန်ပြင်ပေးပါတယ်။

## Existing CFMS users / local data

Legacy CFMS account နဲ့ ByteCraft account email တူရုံနဲ့ အလိုအလျောက် link မလုပ်ပါဘူး။ Account ownership ကို verify လုပ်ထားတဲ့ operator migration လိုပြီး backend က `legacy_account_conflict` / HTTP 409 ပြန်ပါတယ်။ Existing cloud users / stores မဖျက်ထားပါဘူး။ Production မပြောင်းခင် verified identity mapping နဲ့ store ownership ကို migration လုပ်ပါ။

Mobile databases ကို ByteCraft-mapped CFMS user ID အလိုက် သီးခြားဖိုင်တွေနဲ့ ခွဲထားပါတယ်။ အရင် `cfms.sqlite` ကို မဖျက်ပါဘူး။ Account ownership မသေချာတဲ့ legacy file ကို အခြား ByteCraft account ထဲ အလိုအလျောက်မကူးပါဘူး။ Existing users ရဲ့ local-only records ရွှေ့ဖို့ account ownership verify လုပ်ပြီး backup / controlled migration လုပ်ရန် လိုပါတယ်။ Logout က local data မဖျက်ပါဘူး။

## Verification

```bash
# CFMS backend
npm run typecheck
npm run lint
npm test

# Cross-backend tests: build Platform first, Docker required
npm run test:integration
```

Cross-backend tests က disposable PostgreSQL container ထဲမှာ real Platform / CFMS APIs၊ central tokens / JWKS၊ HMAC webhooks၊ Free 402၊ paid upload / limits၊ idempotent cancellation နဲ့ expiry ကို စမ်းပါတယ်။ Development databases ကို မသုံးပါဘူး။

```bash
# Mobile
flutter analyze
flutter test
flutter build apk --debug
```

Real native browser login၊ verification email နဲ့ callback return ကို Android/iOS device ပေါ်မှာ တစ်ကြိမ်စီ စစ်ပါ။ Unit tests က SDK request / refresh token rotation ကို စစ်ပေမယ့် OS browser interaction ကို အစားမထိုးပါဘူး။

## Local API port mismatch

`API_BASE_URL` in `flutter run --dart-define=API_BASE_URL=...`, CFMS backend `.env` `PORT`, and the USB reverse port must agree. The local configuration helper now preserves the configured CFMS port and retargets its existing local webhook instead of resetting the API to 4000.

For example, when using port 4001 on a physical Android device:

```bash
# CFMS backend .env: PORT=4001
adb reverse tcp:3000 tcp:3000
adb reverse tcp:4001 tcp:4001
flutter run --dart-define=API_BASE_URL=http://localhost:4001
```

After changing ports, run `npm run platform:configure:local` in the backend folder and restart the backend. Close an old stuck authorization browser and start sign-in again from CFMS. A completed native authorization now displays an automatic app handoff with an **Open CFMS** fallback link; do not resubmit an old consumed interaction.

## Android callback returns to an expired browser page

If Android logs `AppAuth: No stored state - unable to handle response`, check the main activity task affinity. An empty `android:taskAffinity=""` can put the callback receiver in a different task from the original authorization activity. CFMS removes this attribute so the main activity and AppAuth use the application's default affinity. This matches FlutterAppAuth's documented Android troubleshooting guidance.

The browser may otherwise return to an already-consumed interaction and display **Your sign-in link has expired** even though authorization itself succeeded. Increasing the OAuth interaction TTL does not repair lost Android activity state.

This is a native manifest change: hot reload/restart is insufficient. Stop the current Flutter run, rebuild and reinstall normally (preserving app data), then start a new sign-in. Do not reopen the old interaction URL.

### Device clock and ID token validation

A device clock significantly different from the Platform clock causes the native SDK to reject the ID token even when browser authorization and callback routing succeeded. Enable **Automatic date & time** on the device and keep the server clock synchronized. Do not bypass token time, issuer, audience, nonce or PKCE validation to work around a clock mismatch. CFMS identifies the native ID-token time error and asks the user to check automatic date/time.
