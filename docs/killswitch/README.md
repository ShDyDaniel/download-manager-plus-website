# Kill-switch לחיוב Google Cloud (מתג ניתוק אוטומטי)

מנגנון שמכבה אוטומטית את החיוב בפרויקט גוגל (`n-plus-64549`) כשהעלות
החודשית חוצה סכום שאתה קובע. נועד כ**רשת ביטחון** מפני באג/מתקפה
שמייצרים עלות בלתי צפויה — לא כ"חונק" יומיומי.

> ⚠️ חשוב להבין מראש:
> - **יש עיכוב של כמה שעות** בנתוני החיוב של גוגל → זה לא מיידי לחלוטין.
> - כשהחיוב נכבה, **כל השירותים בתשלום בפרויקט נעצרים** (Firestore מעבר
>   לחינם וכו') והאפליקציה מתנוונת/משתבשת עד שתפעיל חיוב **ידנית** מחדש.
> - לכן: בפיתוח כוון סף **נמוך** (נגיד $3). בייצור כוון **גבוה** (נגיד
>   $50) כדי שצמיחה רגילה (כמה דולרים) לא תפיל את המערכת.

---

## דרישת קדם
זה רלוונטי רק כשהפרויקט ב-**Blaze** (חיוב מופעל). כל עוד אתה ב-Spark
(חינם) — אתה ממילא מוגן (קריאות נחסמות ב-50K ולא מחייבות), אין מה להפעיל.

---

## הפעלה — דרך הקונסול (הכי פשוט)

### 1. צור Pub/Sub topic
Console → **Pub/Sub** → Topics → **Create topic** → שם: `billing-killswitch` → Create.

### 2. צור Budget שמחובר ל-topic
Console → **Billing** → **Budgets & alerts** → **Create budget**:
- **Scope:** בחר את הפרויקט `n-plus-64549` (או "כל הפרויקטים" אם תרצה כיסוי מלא).
- **Amount:** הסכום שאתה רוצה כתקרה (לדוגמה `3` בפיתוח, `50` בייצור).
- **Actions / Manage notifications:** סמן **"Connect a Pub/Sub topic to this budget"** → בחר את `billing-killswitch`.
- שמור.

### 3. פרוס את הפונקציה
Console → **Cloud Functions** (או "Cloud Run functions") → **Create function**:
- **Environment:** 2nd gen
- **Region:** קרוב אליך (למשל `europe-west1` / `us-central1`)
- **Trigger:** Add trigger → **Cloud Pub/Sub** → בחר את ה-topic `billing-killswitch`.
- **Runtime:** Node.js 20
- **Entry point:** `stopBilling`
- **Source:** הדבק את `index.js` ואת `package.json` מהתיקייה הזו.
- **Runtime → Environment variables:** הוסף
  `PROTECTED_PROJECT_ID = n-plus-64549`
- Deploy.

### 4. תן לפונקציה הרשאה לכבות חיוב (הכי חשוב)
לפונקציה יש "service account" (חשבון שירות). צריך לתת לו הרשאת חיוב:
- Console → **Billing** → בחר את חשבון החיוב → **Account management** (או IAM של חשבון החיוב) → **Add member**:
  - Member = ה-service account של הפונקציה (משהו כמו
    `PROJECT_NUMBER-compute@developer.gserviceaccount.com` או ה-SA
    שיצרת לפונקציה).
  - Role = **Billing Account Administrator**.
- שמור.

> בלי השלב הזה הפונקציה תרוץ אבל **תיכשל** בניסיון לכבות חיוב (אין הרשאה).

זהו. מעכשיו, אם העלות חוצה את הסכום — הפונקציה מכבה את החיוב והעלות נעצרת.

---

## הפעלה — דרך שורת הפקודה (חלופה מהירה)
```bash
# 0. הגדר משתנים
PROJECT=n-plus-64549
REGION=europe-west1
gcloud config set project $PROJECT

# 1. topic
gcloud pubsub topics create billing-killswitch

# 2. פריסת הפונקציה (מתוך תיקיית docs/killswitch)
gcloud functions deploy billing-killswitch \
  --gen2 --runtime=nodejs20 --region=$REGION \
  --trigger-topic=billing-killswitch \
  --entry-point=stopBilling \
  --set-env-vars=PROTECTED_PROJECT_ID=$PROJECT

# 3. את ה-Budget המחובר ל-topic יוצרים בקונסול (Billing → Budgets),
#    וההרשאה (Billing Account Administrator ל-SA של הפונקציה) — גם
#    בקונסול, כי זו הרשאה ברמת חשבון החיוב.
```

---

## בדיקה (זהירות — זה באמת מכבה חיוב)
אפשר לפרסם הודעת-בדיקה ל-topic עם עלות מעל התקציב:
```bash
gcloud pubsub topics publish billing-killswitch \
  --message='{"costAmount":999,"budgetAmount":1}'
```
אם הכל מוגדר נכון — הפונקציה תכבה את החיוב (תראה בלוגים `BILLING DISABLED`).

## שחזור (כשרוצים להחזיר חיוב)
Console → **Billing** → **Account management / Projects** → קשר מחדש את
חשבון החיוב לפרויקט `n-plus-64549`. החיוב חוזר והשירותים בתשלום שבים לפעול.

---

## מה לכוון בכל שלב
| שלב | סכום מומלץ | למה |
|-----|-----------|-----|
| פיתוח (אחרי מעבר ל-Blaze) | ~$3 | תופס באג שרץ פרוע |
| השקה / ייצור | ~$25–$50 | צמיחה רגילה זולה (סנטים-דולרים), המתג נכנס רק באסון |

מומלץ להוסיף גם **התראות תקציב** (באותו Budget, "Set budget alerts" ב-50%/90%/100%) — כדי לקבל מייל **לפני** שהמתג בכלל מגיע לפעולה.
