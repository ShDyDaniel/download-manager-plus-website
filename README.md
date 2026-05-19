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
    Hero.tsx           ← מסך פתיחה + כפתורי הורדה + כפתור קניית Pro
    Features.tsx       ← רשת 12 הפיצ'רים
    Pricing.tsx        ← מסך קנייה (PayPal Smart Buttons)
    QuickStart.tsx     ← הצעדים הראשונים
    FAQ.tsx            ← שאלות נפוצות
    Footer.tsx         ← פוטר
  App.tsx              ← layout ראשי
  main.tsx             ← entry point
  index.css            ← styles גלובלי + Tailwind
api/
  capture.ts           ← Vercel function — מקבל אישור PayPal, יוצר מפתח, שולח מייל
public/
  icon.png             ← אייקון האפליקציה
```

## תהליך הקנייה — איך זה עובד

1. הלקוח לוחץ "קנה Pro" ב-Hero → דף גולל לסקציית `Pricing`.
2. ממלא מייל → לוחץ "המשך לתשלום".
3. PayPal Smart Buttons מציגות כפתור צהוב; לחיצה פותחת popup של PayPal *באתר עצמו* (לא redirect).
4. הלקוח מאשר את התשלום של 60 ₪.
5. הקליינט שולח את ה-`orderID` ל-`/api/capture`.
6. ה-Vercel function:
   - מאמת ולוכד את התשלום מול PayPal REST API.
   - מוודא שהסכום בדיוק 60 ₪.
   - יוצר רשומת `productKeys/{XXXX-XXXX-XXXX-XXXX}` ב-Firestore עם תוקף 365 ימים.
   - שולח מייל ללקוח עם המפתח דרך Resend.
7. הקליינט מציג הודעת הצלחה.

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
