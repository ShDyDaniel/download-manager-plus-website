# ניהול הורדות פלוס · Website

אתר תדמית/הורדה לאפליקציית "ניהול הורדות פלוס".

## פיתוח מקומי

```bash
npm install
npm run dev
```

האתר ייפתח על `http://localhost:5173`.

## בנייה

```bash
npm run build
```

הפלט הסופי נמצא ב-`dist/`.

## פריסה ל-GitHub Pages

GitHub Actions בריפו (`.github/workflows/deploy.yml`) מריץ build + deploy
אוטומטי בכל push ל-`main`. אין צורך לעשות שום דבר ידני.

לפריסה ידנית (אם צריך):

```bash
npm run deploy
```

זה דורש `gh-pages` להיות מותקן (הוא כן ב-`devDependencies`).

## הורדות אוטומטיות

הכפתורי "הורד ל-Mac/Windows" שולפים בזמן ריצה את ה-release האחרון מ-
`ShDyDaniel/download-manager-plus-releases` דרך GitHub API. ככה לא צריך
לעדכן את האתר בכל פרסום של גרסה חדשה — מספיק לפרסם release ב-GitHub.

## מבנה תיקיות

```
src/
  api/releases.ts      ← שליפת מטא-דאטה של הגרסה האחרונה
  components/
    Hero.tsx           ← מסך פתיחה + כפתורי הורדה + CTA "קנו עכשיו"
    Features.tsx       ← רשת 12 הפיצ'רים
    QuickStart.tsx     ← הצעדים הראשונים
    FAQ.tsx            ← שאלות נפוצות
    Footer.tsx         ← פוטר
  pages/
    BuyPage.tsx        ← דף קנייה ייעודי (/buy) עם בחירת חודשי/שנתי
  App.tsx              ← Router + layout
  main.tsx             ← entry point + BrowserRouter
  index.css            ← styles גלובלי + Tailwind
api/
  capture.ts           ← Vercel function — מקבל אישור PayPal, יוצר מפתח, שולח מייל
public/
  icon.png             ← אייקון האפליקציה
vercel.json            ← SPA rewrites + /api passthrough
```

## תהליך הקנייה — איך זה עובד

1. הלקוח לוחץ **"קנו עכשיו"** ב-Hero → ניווט לדף `/buy`.
2. ב-`/buy` בוחר בין:
   - **חודשי** — 9 ₪ ל-30 ימים (מתחדש ידנית).
   - **שנתי** — 60 ₪ ל-365 ימים (חיסכון 44%, ברירת מחדל).
3. ממלא מייל → לוחץ "המשך לתשלום".
4. PayPal Smart Buttons מציגות כפתור צהוב; לחיצה פותחת popup של PayPal *באתר עצמו* (לא redirect).
5. הלקוח מאשר את התשלום.
6. הקליינט שולח את `orderID + plan` ל-`/api/capture`.
7. ה-Vercel function:
   - מאמת ולוכד את התשלום מול PayPal REST API.
   - מוודא שהסכום תואם לתוכנית שנבחרה (9 או 60 ₪).
   - יוצר רשומת `productKeys/{XXXX-XXXX-XXXX-XXXX}` ב-Firestore עם תוקף 30 או 365 ימים בהתאם.
   - שולח מייל ללקוח עם המפתח דרך Resend.
8. הקליינט מציג הודעת הצלחה.

## משתני סביבה ב-Vercel

לפני שהקנייה תעבוד, צריך להגדיר את המשתנים הבאים ב-Vercel Dashboard
(Project Settings → Environment Variables):

| משתנה | איפה משיגים | הערות |
|---|---|---|
| `VITE_PAYPAL_CLIENT_ID` | developer.paypal.com → My Apps → Create App | public, נכנס לבילד של ה-HTML |
| `PAYPAL_CLIENT_SECRET` | באותו מסך | server-only |
| `PAYPAL_ENV` | `live` או `sandbox` | ברירת מחדל live |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase Console → Project settings → Service accounts → Generate new private key | מדביקים את כל ה-JSON כשורה אחת |
| `RESEND_API_KEY` | resend.com → API Keys | חינמי, 3000 מיילים/חודש |
| `FROM_EMAIL` | מייל שמאומת ב-Resend | למשל `noreply@dm-plus.com` או `onboarding@resend.dev` לבדיקות |

אחרי שמירת המשתנים, יש לעשות **Redeploy** מ-Vercel.
