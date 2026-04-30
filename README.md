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
    Hero.tsx           ← מסך פתיחה + כפתורי הורדה
    Features.tsx       ← רשת 12 הפיצ'רים
    QuickStart.tsx     ← הצעדים הראשונים
    FAQ.tsx            ← שאלות נפוצות
    Footer.tsx         ← פוטר
  App.tsx              ← layout ראשי
  main.tsx             ← entry point
  index.css            ← styles גלובלי + Tailwind
public/
  icon.png             ← אייקון האפליקציה
```
