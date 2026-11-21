# CFMS backend ကို Railway မှာ deploy လုပ်ရန်

BizKyat / CFMS API ကို Railway ပေါ်တင်ပြီး production ByteCraft နဲ့ ချိတ်ရန် အဆင့်တွေပါ။ Repo က `https://github.com/MyaThanHtet/CFMS-backend.git` ဖြစ်ပြီး Dockerfile က repo အမြစ်မှာ ရှိပြီးသားပါ။

ဖုန်းက ဒီ CFMS API ကို `API_BASE_URL` နဲ့ ခေါ်ပါတယ်။ ByteCraft issuer ကို ဖုန်းထဲမှာ မရေးပါ။ CFMS က `GET /v1/platform/config` ကနေ issuer နဲ့ native client id တွေကို ပြန်ပေးပါတယ်။

## မလုပ်ရသော အရာများ

- `prisma migrate dev` မသုံးပါနဲ့။ Production စတင်ချိန်မှာ `docker/entrypoint.sh` က `prisma migrate deploy` ကို အလိုအလျောက် လုပ်ပါတယ်။
- Prisma ကို 7.10.1 ကနေ မတိုးပါနဲ့။
- Local `npm run platform:configure:local` ကို production ByteCraft မှာ မသုံးပါနဲ့။ အဲဒီ script က local database အတွက်သာ ဖြစ်ပါတယ်။
- `.env` ကို commit မလုပ်ပါနဲ့။ Secret တွေကို Railway Variables ထဲမှာပဲ ထားပါ။
- `PORT` ကို 3000 သို့မဟုတ် 4000 လို့ ကိုယ်တိုင် မသတ်မှတ်ပါနဲ့။ Railway က ပေးတဲ့ `PORT` ကို app က နားထောင်ပါတယ်။
- Public URL နောက်မှာ `:3000` မထည့်ပါနဲ့။ Railway edge က HTTPS port 443 ပါ။

## 1. Railway project ဖွင့်ရန်

1. [Railway](https://railway.com) မှာ GitHub account `MyaThanHtet` နဲ့ login လုပ်ပါ။
2. **New Project** ကို နှိပ်ပါ။
3. Project အမည်ကို `cfms` လို မှတ်ထားပါ။ ByteCraft production service နဲ့ project တူစရာ မလိုပါ။

## 2. PostgreSQL ထည့်ရန်

1. Project ထဲမှာ **Create** → **Database** → **PostgreSQL** ကို ရွေးပါ။
2. Database service ကို deploy ပြီးသည်အထိ စောင့်ပါ။
3. ဒီ database ရဲ့ `DATABASE_URL` ကို နောက်အဆင့်မှာ API service က ကိုးကားပါမယ်။ Local `localhost:5434` URL ကို မသုံးပါနဲ့။

## 3. API service ကို GitHub ကနေ ချိတ်ရန်

1. **Create** → **GitHub Repo** → `MyaThanHtet/CFMS-backend` ကို ရွေးပါ။
2. Branch က `main` ဖြစ်ရပါမယ်။
3. **Root Directory** ကို ဗလာထားပါ။ ဒီ repo တစ်ခုလုံးက backend ပါ။ `cfms-backend/` လို့ ထပ်မထည့်ပါနဲ့။
4. Builder က **Dockerfile** ဖြစ်ရပါမယ်။ Repo အမြစ်က `Dockerfile` ကို Railway က တွေ့ရင် အဲဒါကို သုံးပါတယ်။

Dockerfile က ဘာလုပ်လဲ ဆိုရင်:

- Node.js 22 image နဲ့ `npm ci` လုပ်ပါတယ်။ `tsx` က devDependency ဖြစ်လို့ Nixpacks production install ကနေ ချန်ခဲ့နိုင်ပါတယ်။ Dockerfile လမ်းကြောင်းက အဲဒါကို ရှောင်ပါတယ်။
- Build အတွင်း `prisma generate` လုပ်ပါတယ်။ Generated client က git ထဲ မပါပါ။
- Container စတိုင်း `docker/entrypoint.sh` က `prisma migrate deploy` လုပ်ပြီး `tsx src/main.ts` နဲ့ API ကို ဖွင့်ပါတယ်။

Nixpacks ကို ပြောင်းမသုံးပါနဲ့။ Start command ကိုလည်း မထပ်ရေးပါနဲ့။ Image ထဲက entrypoint ပဲ လုံလောက်ပါတယ်။

## 4. Variables ထည့်ရန်

API service → **Variables** ထဲမှာ ဒီတန်ဖိုးတွေ ထည့်ပါ။ Client id နဲ့ webhook secret က production ByteCraft Back Office မှာ မှတ်ထားတဲ့ တန်ဖိုးတွေ ဖြစ်ရပါမယ်။ Local `.env` ထဲက client id တွေကို ကူးမထည့်ပါနဲ့။

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `BYTECRAFT_ISSUER` | `https://bytecraft-platform-backend-production.up.railway.app` |
| `BYTECRAFT_APP_CODE` | `cfms` |
| `BYTECRAFT_ANDROID_CLIENT_ID` | production Android public client id |
| `BYTECRAFT_IOS_CLIENT_ID` | production iOS public client id |
| `BYTECRAFT_CLIENT_IDS` | Android id နဲ့ iOS id ကို comma ခြားပြီး တစ်ကြောင်းတည်း |
| `BYTECRAFT_REDIRECT_URI` | `com.cfms.mobile:/oauth2redirect` |
| `BYTECRAFT_WEBHOOK_CLIENT_ID` | webhook destination နဲ့ map ထားတဲ့ client id |
| `BYTECRAFT_WEBHOOK_SECRET` | production webhook secret |

`DATABASE_URL` ကို စာသားအဖြစ် ကူးမရေးဘဲ Postgres service variable ကို reference လုပ်ပါ။ Railway UI မှာ variable reference က `${{Postgres.DATABASE_URL}}` ပုံစံပါ။ Database service အမည်က `Postgres` မဟုတ်ရင် အဲဒီ service အမည်ကို သုံးပါ။

`BYTECRAFT_ISSUER` စည်းမျဉ်း:

- `https://` နဲ့ စရမယ်။ `NODE_ENV=production` မှာ HTTP issuer ကို API က ပယ်ပါတယ်။
- Origin ပဲ ဖြစ်ရမယ်။ အဆုံး `/` မပါရပါဘူး။ Path မပါရပါဘူး။
- `:3000` မထည့်ပါနဲ့။ အဲဒီ port က ByteCraft container အတွင်းပိုင်း port ပါ။ Public hostname က port မပါဘဲ ဖွင့်ပြီးသားပါ။

`JWT_ACCESS_SECRET` မလိုပါ။ Production sign-in က ByteCraft RS256 token ကို သုံးပါတယ်။

Variable ပြောင်းပြီးတိုင်း service ကို redeploy လုပ်ပါ။

## 5. Public URL နဲ့ health check

1. API service → **Settings** → **Networking** → **Generate Domain**။
2. ရလာတဲ့ URL က `https://<service>.up.railway.app` ပုံစံပါ။ Port မပါပါ။
3. Health check path ကို `/health` ထားပါ။

`/health` က database မေးပါတယ်။

- Database ရောက်ရင် HTTP 200၊ `"status": "ok"`၊ `"database": "up"`။
- Database မရောက်ရင် HTTP 503။

## 6. Deploy ပြီးကြောင်း စစ်ရန်

Deploy log ထဲမှာ `prisma migrate deploy` အောင်ပြီး server နားထောင်ကြောင်း ရှိရပါမယ်။ ပြီးရင် ဒီနှစ်ခုကို ဖွင့်ပါ။ `<cfms>` နေရာမှာ Railway ကပေးတဲ့ hostname ကို ထည့်ပါ။

```bash
curl https://<cfms>.up.railway.app/health
curl https://<cfms>.up.railway.app/v1/platform/config
```

`/v1/platform/config` ထဲမှာ ဒီပုံစံ ပါရပါမယ်။

- `configured` က `true`
- `issuer` က `https://bytecraft-platform-backend-production.up.railway.app`
- `androidClientId` နဲ့ `iosClientId` က production client id
- `redirectUri` က `com.cfms.mobile:/oauth2redirect`
- webhook secret မပါရပါ

## 7. ByteCraft ဘက်မှာ webhook ချိတ်ရန်

Production ByteCraft Back Office မှာ application `cfms` အတွက် webhook destination ကို ဒီ URL ဆီ မှတ်ပါ။

```text
https://<cfms>.up.railway.app/v1/platform/webhook
```

Destination နဲ့ map ထားတဲ့ client id က `BYTECRAFT_WEBHOOK_CLIENT_ID` နဲ့ တူရပါမယ်။ Secret က `BYTECRAFT_WEBHOOK_SECRET` နဲ့ တူရပါမယ်။ Secret ကို mobile app ထဲ မထည့်ပါနဲ့။

Native client တွေရဲ့ redirect URI က `com.cfms.mobile:/oauth2redirect` ဖြစ်ပြီး scopes က `openid profile email offline_access platform` ဖြစ်ရပါမယ်။

## 8. BizKyat ဖုန်းကို ဒီ API ဆီ ညွှန်ရန်

ဖုန်းက ByteCraft URL ကို `API_BASE_URL` လုပ်မထားပါနဲ့။ CFMS Railway URL ကိုပဲ ပေးပါ။

```bash
flutter run --dart-define=API_BASE_URL=https://<cfms>.up.railway.app
```

Release build မှာလည်း ဒီ HTTPS URL ပဲ သုံးပါ။ Sign in ကို app ထဲကနေ အသစ်စပါ။ Browser ထဲက အဟောင်း authorization link ကို ပြန်မဖွင့်ပါနဲ့။

## ပျက်တတ်တဲ့ အချက်များ

| လက္ခဏာ | ပြင်ရန် |
| --- | --- |
| Boot မှာ `Production requires an HTTPS ByteCraft issuer` | `NODE_ENV=production` နဲ့ issuer ကို `https://` origin အဖြစ်ထားပါ။ |
| Boot မှာ `BYTECRAFT_ISSUER` invalid | အဆုံး `/`၊ path၊ `:3000` ကို ဖြုတ်ပါ။ |
| `prisma migrate deploy` fail | `DATABASE_URL` က Railway Postgres reference ဖြစ်ကြောင်း စစ်ပါ။ |
| `/health` က 503 | API နဲ့ Postgres က project တစ်ခုတည်းထဲမှာ ရှိပြီး private `DATABASE_URL` ကို သုံးထားကြောင်း စစ်ပါ။ |
| `/v1/platform/config` မှာ `configured: false` | Android/iOS client id နှစ်ခုလုံးကို `BYTECRAFT_CLIENT_IDS` ထဲ ထည့်ပြီး redeploy လုပ်ပါ။ |
| ဖုန်းမှာ native client မရှိကြောင်း ပေါ်သည် | Production Back Office client id ကို သုံးပါ။ Local helper id မဟုတ်ပါ။ |
| Webhook 401 / 403 | URL၊ client id၊ secret တို့ကို ByteCraft destination နဲ့ တိုက်ကြည့်ပါ။ |
