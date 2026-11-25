# TubeSmart AI — تيوب سمارت | استوديو رفع وتحسين فيديوهات يوتيوب

منصة متكاملة لرفع الفيديوهات على **YouTube** مبنية بـ **Next.js (App Router) + Node.js + PostgreSQL (Drizzle ORM)**.

> **لا تحتاج أي مفاتيح ذكاء اصطناعي خارجية** — محرك التحليل والسيو مدمج داخل المشروع.
> **لا تحتاج ملف `.env`** — المشروع يعمل مباشرة، والمتغير الوحيد المطلوب على الاستضافة هو `DATABASE_URL`.

## المميزات

- ربط حقيقي بقناة اليوتيوب عبر **Google OAuth 2.0 & YouTube Data API v3** (مع وضع تجريبي فوري).
- رفع الفيديوهات مع استخراج الصورة المصغرة والمدة والدقة تلقائياً.
- **محرك تيوب سمارت الذكي**: يفهم موضوع الفيديو من اسم الملف ووصفك ونص السكربت، ويستخرج الكلمات المفتاحية الفعلية من المحتوى (عربي/إنجليزي).
- توليد **5 عناوين جذابة عالية النقر (CTR)** مع معاينة حية لنتائج بحث يوتيوب.
- توليد **وصف احترافي** بالفصول الزمنية (Chapters) والهاشتاجات ودعوة الاشتراك.
- **تاجز وكلمات مفتاحية طويلة الذيل (Long-Tail)** مع مؤشرات حجم البحث والمنافسة وعدّاد 500 حرف الرسمي.
- ضبط كل إعدادات يوتيوب: اللغة، التصنيف، الخصوصية، الجدولة، مخصص للأطفال، الترخيص، التعليقات، التضمين، الإشعارات، موقع التصوير.
- توليد وتحرير وتنزيل **ترجمات (`.srt` / `.vtt`)** بعدة لغات ورفعها مع الفيديو.
- نشر مباشر إلى YouTube عبر **Resumable Upload API** (فيديو + صورة مصغرة + ترجمات).
- كل المفاتيح الحساسة تُحفظ **مشفّرة AES-256-GCM داخل قاعدة البيانات** من داخل الموقع.

## التشغيل محلياً (بدون أي إعداد)

```bash
npm install
npm run dev
```

يعمل تلقائياً على `postgresql://postgres:postgres@127.0.0.1:5432/app_db`.
لإنشاء الجداول: `npx drizzle-kit push`.

## النشر على Bonto (bonto.dev) من GitHub

1. **ارفع المشروع على GitHub**
   ```bash
   git init && git add . && git commit -m "TubeSmart AI"
   git branch -M main
   git remote add origin https://github.com/USERNAME/REPO.git
   git push -u origin main
   ```

2. **أنشئ قاعدة PostgreSQL مجانية** على [neon.tech](https://neon.tech) أو Supabase وانسخ رابط الاتصال.

3. **في [bonto.dev/dashboard](https://bonto.dev/dashboard)**: New App → Node.js → Import from GitHub، ثم في الإعدادات:
   - Node version: **22**
   - Build command: `npm run build:bonto`
   - Start command: `npm run start:bonto`

4. **Environment Variables**: أضف متغيراً واحداً فقط:
   ```
   DATABASE_URL=postgresql://USER:PASS@HOST/DB?sslmode=require
   ```
   (اختياري: `APP_BASE_URL`، `APP_ENCRYPTION_KEY` — ويمكن ضبط بيانات Google من داخل الموقع.)

5. **Google Cloud Console**: فعّل YouTube Data API v3 وأنشئ OAuth Client (Web) مع Redirect URI:
   `https://your-app.bonto.page/api/auth/youtube/callback`

> `build:bonto` ينشئ جداول قاعدة البيانات تلقائياً (`drizzle-kit push`) ثم يبني Next.js بوضع `standalone` وينسخ الملفات الثابتة. كل `git push` يعيد النشر تلقائياً.

## ضبط بيانات Google من داخل الموقع

افتح صفحة **«ربط القناة و API»** وأدخل `Google Client ID` و`Google Client Secret` ورابط موقعك — تُحفظ مشفّرة في جدول `app_settings` داخل قاعدة البيانات، ثم اضغط «ربط قناتك عبر Google OAuth».
