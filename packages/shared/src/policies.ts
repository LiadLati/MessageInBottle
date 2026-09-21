import { z } from 'zod';

// The three documents a person is shown before creating an account: Terms of Use, Community
// Guidelines and the Privacy Policy. This module is their single source of truth — the API
// serves them from here, validates acceptances against the versions here, and the web renders
// them from here — so the version a person accepted is always the version they were shown.
//
// STATUS: these texts are a WORKING DRAFT (0.1-draft), corrected against what the product
// actually does but not yet reviewed by a lawyer, and with the operator's details, the data
// inventory of the deployment, the retention policy and the minimum age still undecided. Every
// such gap is written as an inline [[…]] marker. Nothing is guessed in its place.
//
// Releasing a document means: a human decides each marker, the text is reviewed, `status`
// becomes 'released', `version` is bumped and `effectiveAt` is set. `validatePolicySet` refuses
// a released document that still carries a marker, and the API refuses to run on one; the
// registration flow in a production build refuses to collect acceptances of a draft at all.
// Accounts that accepted an earlier version are asked again on their next sign-in; nothing is
// ever silently carried over.

export const POLICY_IDS = ['terms', 'guidelines', 'privacy'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];
export const PolicyIdSchema = z.enum(POLICY_IDS);

// What the person does with each document at registration. The Terms and the Guidelines are
// accepted (they bind); the Privacy Policy is acknowledged (it informs — showing it is not, by
// itself, consent to anything beyond what running the service needs).
export const POLICY_ACTION: Record<PolicyId, 'accepted' | 'acknowledged'> = {
  terms: 'accepted',
  guidelines: 'accepted',
  privacy: 'acknowledged',
};

export type PolicyStatus = 'draft' | 'released';

// Content is structured, never HTML, so it renders through ordinary elements with real
// headings, lists and tables that a screen reader can navigate. Inline `[[text]]` marks an
// unresolved field; it renders as a highlighted "to be completed" span and is counted by
// `openItemsOf`.
export type PolicyBlock =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'table'; head: string[]; rows: string[][] };

export interface PolicyDocument {
  id: PolicyId;
  // UI chrome (menu entries, tab titles) is in the app's language; the text itself is Hebrew.
  title: string;
  titleHe: string;
  lang: 'he';
  dir: 'rtl';
  version: string;
  status: PolicyStatus;
  // ISO date the document came into force; null while it is a draft.
  effectiveAt: string | null;
  // Facts in this document that hold only once a named change has shipped. Listed so the
  // dependency is visible in the app and in the report, not buried in a commit message.
  dependsOn: string[];
  blocks: PolicyBlock[];
}

const OPEN = /\[\[([^\]]+)\]\]/g;

// Every unresolved field in a document, in order of appearance.
export function openItemsOf(doc: PolicyDocument): string[] {
  const out: string[] = [];
  const scan = (s: string) => {
    for (const m of s.matchAll(OPEN)) out.push(m[1]!.trim());
  };
  for (const b of doc.blocks) {
    if (b.type === 'h2' || b.type === 'h3' || b.type === 'p') scan(b.text);
    else if (b.type === 'ul' || b.type === 'ol') b.items.forEach(scan);
    else {
      b.head.forEach(scan);
      b.rows.forEach((r) => r.forEach(scan));
    }
  }
  return out;
}

// Splits a string into plain text and unresolved segments for rendering.
export function segmentsOf(text: string): Array<{ kind: 'text' | 'open'; text: string }> {
  const parts: Array<{ kind: 'text' | 'open'; text: string }> = [];
  let last = 0;
  for (const m of text.matchAll(OPEN)) {
    const at = m.index;
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) });
    parts.push({ kind: 'open', text: (m[1] ?? '').trim() });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

// A released document must carry no open marker, a version and an effective date. Used by the
// tests and by the API at boot, so a half-finished release cannot be served as final.
export function validatePolicySet(docs: readonly PolicyDocument[]): string[] {
  const problems: string[] = [];
  for (const id of POLICY_IDS)
    if (!docs.some((d) => d.id === id)) problems.push(`missing document: ${id}`);
  for (const d of docs) {
    if (!/^\d+\.\d+(\.\d+)?(-draft)?$/.test(d.version))
      problems.push(`${d.id}: version "${d.version}" is not N.N[.N][-draft]`);
    if (d.status === 'draft' && !d.version.endsWith('-draft'))
      problems.push(`${d.id}: a draft's version must end in -draft`);
    if (d.status === 'released') {
      if (d.version.endsWith('-draft'))
        problems.push(`${d.id}: a released version cannot be a draft`);
      if (!d.effectiveAt) problems.push(`${d.id}: a released document needs effectiveAt`);
      const open = openItemsOf(d);
      if (open.length) problems.push(`${d.id}: released with ${open.length} unresolved field(s)`);
    }
  }
  return problems;
}

// ---------- acceptance ----------

// Sent with registration and by an existing account asked to accept a newer version. Each flag
// must be literally true — a missing or false flag is a schema failure, never a default — and
// the versions must be the ones the person was shown, so a stale form cannot accept a version
// it never displayed. The server compares them with the current versions.
export const PolicyVersionsSchema = z.object({
  terms: z.string().min(1).max(32),
  guidelines: z.string().min(1).max(32),
  privacy: z.string().min(1).max(32),
});
export type PolicyVersions = z.infer<typeof PolicyVersionsSchema>;

export const PolicyAcceptanceRequestSchema = z.object({
  acceptTerms: z.literal(true),
  acceptGuidelines: z.literal(true),
  acknowledgePrivacy: z.literal(true),
  versions: PolicyVersionsSchema,
});
export type PolicyAcceptanceRequest = z.infer<typeof PolicyAcceptanceRequestSchema>;

// What an account has on record, per document, beside what is current. `required` is true when
// the current set is released and any document's accepted version differs from the current one
// — including "never accepted", which is what every account created before this existed has.
export const PolicyDocumentStatusSchema = z.object({
  id: PolicyIdSchema,
  title: z.string(),
  currentVersion: z.string(),
  action: z.enum(['accepted', 'acknowledged']),
  acceptedVersion: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});
export const AccountPoliciesSchema = z.object({
  status: z.enum(['draft', 'released']),
  required: z.boolean(),
  documents: z.array(PolicyDocumentStatusSchema),
});
export type AccountPoliciesDto = z.infer<typeof AccountPoliciesSchema>;

export const PolicySetResponseSchema = z.object({
  status: z.enum(['draft', 'released']),
  documents: z.array(
    z.object({
      id: PolicyIdSchema,
      title: z.string(),
      titleHe: z.string(),
      version: z.string(),
      effectiveAt: z.string().nullable(),
    }),
  ),
});

// ---------- the documents ----------

const DRAFT_VERSION = '0.1-draft';

// Facts that are true only once the reporting-and-moderation branch has shipped. They are
// stated as the product will behave, because the documents cannot be released before then
// anyway; the dependency is listed on each document that relies on it.
const MODERATION_DEPENDENCY =
  'feature/reporting-and-moderation merged: reporting from the reader, one case per letter, admin decisions, the warning/suspension/ban ladder, one appeal per violation, report rate limits';

export const TERMS_OF_USE: PolicyDocument = {
  id: 'terms',
  title: 'Terms of Use',
  titleHe: 'תנאי שימוש',
  lang: 'he',
  dir: 'rtl',
  version: DRAFT_VERSION,
  status: 'draft',
  effectiveAt: null,
  dependsOn: [MODERATION_DEPENDENCY],
  blocks: [
    {
      type: 'p',
      text: 'מועד תחילה: [[להשלים לאחר אישור הנוסח]] · מפעיל השירות: [[שם משפטי מלא, מספר רישום אם יש, מען ופרטי קשר]] · כתובת לפניות: [[כתובת דוא״ל תפעולית פעילה]]',
    },
    { type: 'h2', text: '1. השירות וההסכמה לתנאים' },
    {
      type: 'p',
      text: 'Message in a Bottle (להלן: השירות) הוא שירות דיגיטלי שבו משתמשים כותבים מכתבים בתוך בקבוקים וירטואליים, שולחים אותם אל נמלים וירטואליים, עוקבים אחר מסע מדומה, מקבלים מכתבים וקוראים אותם. המסלול, מזג האוויר, שעות היום והלילה ותנועת הבקבוק הם חלק מחוויית השירות; לא מדובר במשלוח חפץ פיזי או בחיזוי מדעי של הים.',
    },
    {
      type: 'p',
      text: 'פתיחת חשבון ושימוש בשירות כפופים לתנאים אלה ולכללי הקהילה. מדיניות הפרטיות מתארת בנפרד את השימוש במידע אישי. לפני יצירת חשבון מוצגים קישורים לשלושת המסמכים; יצירת החשבון מותנית באישור פעיל של תנאי השימוש וכללי הקהילה, ובאישור נפרד שמדיניות הפרטיות נקראה. השירות שומר לכל חשבון את גרסת המסמכים שאושרה ואת מועד האישור. [[גיל מינימלי: טרם הוחלט וטרם הוטמע. ההצעה שנבדקה היא שימוש מגיל 18 ומעלה בלבד; עד להחלטה ולהטמעה אין להציג דרישת גיל כעובדה.]] אין להתחזות לאחר או לפתוח חשבון למי שאינו רשאי להשתמש בשירות.',
    },
    { type: 'h2', text: '2. החשבון והגישה אליו' },
    {
      type: 'p',
      text: 'לפתיחת חשבון נדרשים שם משתמש, כתובת דוא״ל וסיסמה. כתובת הדוא״ל משמשת לשחזור סיסמה ולפניות הקשורות לחשבון; היא אינה מוצגת למשתמשים אחרים. המשתמש אחראי למסור פרטים נכונים, לשמור על אמצעי הכניסה שלו ולהודיע לנו על שימוש בלתי מורשה באמצעות [[ערוץ התמיכה — להשלים]]. ניתן לבחור שם תצוגה ונמל וירטואלי; בחירה בנמל אינה הצהרה על מקום מגורים ואינה דורשת מסירת כתובת בית. השירות אינו מבקש גישה למיקום המכשיר.',
    },
    {
      type: 'p',
      text: 'אנו רשאים להציב מגבלות סבירות נגד ניצול לרעה. נכון לנוסח זה קיימות בשירות הגבלות קצב על הרשמה, כניסה, שחזור סיסמה ודיווח על מכתבים. אין כיום הגבלת קצב על שליחת מכתבים; אם תתווסף, נעדכן נוסח זה.',
    },
    { type: 'h2', text: '3. מכתבים, מסעות ונמענים' },
    {
      type: 'p',
      text: 'המשתמש אחראי לתוכן שהוא כותב. לפני שליחה יש לזכור שמכתב עשוי להיקרא בידי הנמען, ובנסיבות המתוארות כאן גם בידי מי שמצא בקבוק שאבד והופיע במפה הציבורית. לפני כל שליחה מוצגת אזהרה על כך ונדרש אישור. אין לכלול במכתב מידע רגיש על עצמך או על אדם אחר אם אינך רוצה שמי שיורשה לפתוח אותו יקרא אותו. אין להניח שהנמען או המוצא לא יעתיקו תוכן שקראו; הסרה מהשירות אינה יכולה למחוק עותקים שנשמרו מחוץ לו.',
    },
    {
      type: 'p',
      text: 'משך המסע נגזר מהמסלול הימי ומהמרחק בין הנמלים הווירטואליים, ונקבע בשרת בעת השליחה; פתיחת האפליקציה, רענון או שינוי שעון המכשיר אינם משנים אותו. משלוח בין משתמשים באותו נמל מגיע מיד. מכתב יכול להגיע ליעדו, ללכת לאיבוד בסערת לילה ולהופיע במפה הציבורית, או לטבוע. בקבוק שאבד ומוצג לציבור מוסר מהמפה הציבורית עם פתיחתו על ידי משתמש אחר או כעבור 72 שעות מרגע האבידה, לפי המוקדם; הסרה מהמפה אינה מחיקה של המכתב, של רשומת המסע או של עותקים אחרים במערכות השירות. אין התחייבות למסירה, לזמן הגעה מדויק או לכך שהנמען או מוצא הבקבוק יקראו את המכתב.',
    },
    {
      type: 'p',
      text: 'בקבוק ציבורי ניתן לפתיחה בידי משתמש אחד בלבד. למוצא ניתנת קריאה חד פעמית, עם אפשרות לחזור אליה במשך עד 15 דקות מרגע הפתיחה במקרה של רענון או ניתוק; לאחר מכן המכתב אינו זמין לו עוד, והקריאה אינה יוצרת אצלו ארכיון של המכתב. השולח ממשיך לראות את מכתבו ואת רשומת המסע בחשבונו. מכתבים שטבעו אינם מופיעים במפה הציבורית ואינם נפתחים בידי איש.',
    },
    { type: 'h2', text: '4. זכויות בתוכן' },
    {
      type: 'p',
      text: 'זכויותיו של הכותב במכתביו נשארות בידיו. בשליחת תוכן הוא נותן למפעיל רישיון מוגבל, לא בלעדי וללא תשלום לאחסן, להעביר, להציג למי שהורשה לקרוא, לגבות, לבדוק לצורכי בטיחות ולטפל בדיווחים, במידה הדרושה להפעלת השירות ולהגנה עליו. אין בכך רשות לפרסם מכתב מחוץ לשירות או להשתמש בו לפרסום מסחרי. על המשתמש לוודא שיש לו זכות לשלוח את התוכן ושהוא אינו מפר זכויות של אחרים. העיצוב, הקוד והסימנים של השירות שייכים לבעליהם ואינם מועברים למשתמש.',
    },
    { type: 'h2', text: '5. התנהגות, דיווחים והחלטות' },
    {
      type: 'p',
      text: 'כללי הקהילה הם חלק מתנאי השימוש. אפשר לדווח על מכתב מתוך מסך הקריאה — נמען שהמכתב הגיע לחופו, או מוצא בקבוק במהלך קריאתו החד פעמית — ולבקש להסתירו מהחשבון המדווח באותה פעולה. דיווח אינו קובע לבדו שהייתה הפרה, ואינו בודק או משנה את המכתב; הוא פותח תיק אחד למכתב, שאליו מצטרפים דיווחים נוספים על אותו מכתב. תוכן המכתב שדווח עשוי להיבדק בידי כלי ממוחשב לצורך המלצה בלבד, ולאחר מכן בידי מנהל אנושי. המנהל הוא שמחליט אם לקבל את הדיווח או לדחותו, וההחלטה נרשמת עם זהות המחליט, מועדה ונימוקה. זהות המדווח אינה נמסרת לשולח בהודעת ההחלטה; ייתכנו גילויים הנדרשים על פי דין.',
    },
    {
      type: 'p',
      text: 'הפרה ראשונה שאושרה מובילה לאזהרה חד פעמית המוצגת בכניסה הבאה; הפרה שנייה בתוקף מובילה להשעיית החשבון לשבעה ימים, עם ציון מועד הסיום ואזהרה מפני חסימה קבועה; הפרה שלישית בתוקף מובילה לחסימה קבועה. נספרות רק הפרות שאושרו ושעודן בתוקף; דיווח שנדחה, דיווח שטרם הוכרע והפרה שבוטלה בערעור אינם נספרים. אם כמה אנשים מדווחים על אותו מכתב, נרשמת בשל כך הפרה אחת לכל היותר. מכתב שדיווח עליו התקבל מוסר מקריאה בתוך האפליקציה, לרבות עבור שולחו; רשומת המסע נשמרת ומועדיו אינם משתנים. במקרה של סכנה ממשית או חובה שבדין ניתן להגביל גישה או לפעול באופן מידתי נוסף, בכפוף לבדיקה אנושית ולדין החל. ניסוח כועס, אירוני או סיוע לאדם במצוקה אינם הפרה רק בשל מילים קשות.',
    },
    {
      type: 'p',
      text: 'חשבון מושעה או חסום עדיין יכול להיכנס לשירות, לראות את מצבו, להגיש ערעור ולהתנתק. ניתן להגיש ערעור אחד על כל החלטה שאישרה הפרה, גם במהלך השעיה או חסימה. מנהל יבחן את הערעור ואת התוכן מחדש; אם יתקבל, ההפרה תבוטל ומצב החשבון יחושב מחדש מיד. אם יידחה, לא יינתן ערעור נוסף באותו עניין בתוך השירות. [[מועד אחרון להגשת ערעור: טרם נקבע. השירות אינו מגביל כיום את מועד הערעור, ואין להגדיר מגבלה לפני החלטה, פרסום והטמעה תואמת.]] החלטות אינן שוללות זכויות שהדין מקנה למשתמש.',
    },
    { type: 'h2', text: '6. זמינות, שינויים ותשלום' },
    {
      type: 'p',
      text: 'השירות עשוי להשתנות, לעבור תחזוקה או להיות בלתי זמין מעת לעת. נפעל באופן סביר לשמור על נתונים ועל רציפות הפעולה, אך לא ניתן להבטיח זמינות רציפה או שימור של חוויה מסוימת. לכל גרסה של מסמך זה יש מספר ומועד תחילה, והנוסח העדכני זמין תמיד באפליקציה, גם לפני הרשמה. שינוי מהותי יידרש לאישור מחדש בכניסה הבאה לשירות; אישור של גרסה קודמת אינו נחשב לאישור גרסה חדשה.',
    },
    {
      type: 'p',
      text: 'אין בשירות מנויים, רכישות או אמצעי תשלום, ואין הוא אוסף פרטי תשלום. אם יוצע בעתיד תשלום, יפורסמו מראש המחיר, החיוב, החידוש, הביטול, ההחזר והזכויות הצרכניות הרלוונטיות בנוסח מעודכן ובתהליך הרכישה.',
    },
    { type: 'h2', text: '7. הגבלת אחריות, דין ופניות' },
    {
      type: 'p',
      text: 'המפעיל ינהג במיומנות ובאחריות סבירה בהתאם לדין. אחריות לתוכן שהמשתמש יצר נשארת עליו ככל שהדין קובע, אך סעיף זה אינו פוטר את המפעיל מחובותיו על פי דין, מרשלנות שאין להתנות עליה או מזכויות צרכניות שלא ניתן לוותר עליהן. אין בשירות ייעוץ רפואי, משפטי או שירות חירום; במקרה של סכנה מיידית יש לפנות לגורמי חירום מתאימים.',
    },
    {
      type: 'p',
      text: 'לפניות בעניין חשבון, דיווח, ערעור או תקלה: [[פרטי קשר וזמני מענה אמיתיים — להשלים]]. דין חל וערכאה מוסמכת: [[לקביעה לאחר בירור זהות המפעיל, קהל היעד והדין החל; אין לגרוע מסמכות או מזכויות שאי אפשר להתנות עליהן]].',
    },
  ],
};

export const COMMUNITY_GUIDELINES: PolicyDocument = {
  id: 'guidelines',
  title: 'Community Guidelines',
  titleHe: 'כללי הקהילה',
  lang: 'he',
  dir: 'rtl',
  version: DRAFT_VERSION,
  status: 'draft',
  effectiveAt: null,
  dependsOn: [MODERATION_DEPENDENCY],
  blocks: [
    {
      type: 'p',
      text: 'הכלל המנחה: מכתב עשוי להגיע לאדם שלא מכיר את הכותב. מותר לכתוב גם טקסט עצוב, אישי, ביקורתי או בדיוני; אין להשתמש בשירות כדי לפגוע באנשים, לחשוף אותם או לנצל אותם.',
    },
    { type: 'h2', text: 'מותר' },
    {
      type: 'ul',
      items: [
        'לכתוב חוויות, שירה, דעות, בדיחות וסיפורים שלא מפרים את הכללים; ההקשר והמשמעות חשובים.',
        'לדווח בתום לב על תוכן מטריד ולהסתיר אותו מהחשבון שלך, גם כאשר בסוף הבדיקה הדיווח נדחה.',
        'לחסום משתמש. חסימה מונעת התכתבות בשני הכיוונים, ואין לעקוף אותה.',
        'לערער פעם אחת על החלטה שאישרה הפרה, ולספק הקשר שעשוי לשנות את ההכרעה.',
      ],
    },
    { type: 'h2', text: 'אסור' },
    {
      type: 'ol',
      items: [
        'איומים אמינים, סחיטה, הסתה לאלימות או הדרכה לפגיעה באדם אחר.',
        'הטרדה ממוקדת, השפלה מתמשכת, קללות המכוונות לאדם באופן פוגעני או דברי שנאה כלפי קבוצות מוגנות.',
        'לחץ מיני לא רצוי, הטרדה מינית, ניצול מיני, ובפרט כל חומר המנצל קטינים או מבקש להשיגו.',
        'חשיפת כתובת, מספר טלפון, מידע מזהה או מידע רגיש של אחר ללא הצדקה והרשאה, וכן איום לחשוף אותו.',
        'התחזות, תרמית, בקשה לסיסמאות או לפרטי תשלום, קישורים שמטרתם לגנוב מידע, ספאם או פרסום בלתי מורשה.',
        'ניסיון לעקוף חסימה או מגבלת חשבון, שימוש בכמה חשבונות לצורכי הטרדה, פגיעה במערכת, או דיווחי שווא מכוונים כדי לפגוע במשתמש אחר.',
        'תוכן שמפר זכויות של אחרים או חוק חל.',
      ],
    },
    {
      type: 'p',
      text: 'מכתב פרידה לא נעים, ביטוי מושאל בשיר, סלנג או פנייה תומכת לאדם במצוקה אינם עבירה רק משום שהם כוללים מילים קשות. בבדיקה יש להתחשב בהקשר, בשפה ובאפשרות לטעות של כלי ממוחשב. דיווח דחוף על סכנה אינו תחליף לפנייה לגורמי חירום, והשירות אינו מוקד חירום.',
    },
    { type: 'h2', text: 'מה קורה בעקבות דיווח' },
    {
      type: 'p',
      text: 'הדיווח נרשם לטיפול בתיק אחד למכתב, ואפשר להסתיר את המכתב עבור המדווח באותה פעולה. המלצת כלי ממוחשב, אם הופקה, מוצגת למנהל עם נימוק, עם ציון מה אינו ברור לו, ולצד תרגום — המקור מוצג תמיד; היא אינה החלטה. המנהל קורא את המכתב ומחליט לקבל או לדחות את הדיווח. אם הדיווח מתקבל, המכתב מוסר מקריאה בתוך האפליקציה, לשולח מוצגות הודעה ואפשרות ערעור, וזהות המדווח אינה נמסרת לו. מספר הדיווחים על אותו מכתב אינו מכפיל את ההפרה. את מדרג האזהרה, ההשעיה, החסימה והערעור מפרט סעיף 5 לתנאי השימוש.',
    },
  ],
};

export const PRIVACY_POLICY: PolicyDocument = {
  id: 'privacy',
  title: 'Privacy Policy',
  titleHe: 'מדיניות פרטיות',
  lang: 'he',
  dir: 'rtl',
  version: DRAFT_VERSION,
  status: 'draft',
  effectiveAt: null,
  dependsOn: [MODERATION_DEPENDENCY],
  blocks: [
    {
      type: 'p',
      text: 'בעל השליטה במידע: [[שם המפעיל ופרטי זיהוי מלאים]] · פנייה בענייני פרטיות: [[דוא״ל ומען]] · מועד תחילה: [[להשלים לאחר אישור הנוסח]]',
    },
    { type: 'h2', text: '1. איזה מידע אנו מעבדים' },
    {
      type: 'p',
      text: 'הטבלה שלהלן נבדקה מול הקוד ומסד הנתונים של השירות בתאריך 19.09.2026. היא מתארת מה השירות עצמו אוסף ושומר; מה ששומרים ספקי התשתית שבהם ייעשה שימוש בפריסה תלוי בפריסה ומסומן כפתוח.',
    },
    {
      type: 'table',
      head: ['סוג מידע', 'מה בדיוק, ומקורו', 'מדוע הוא דרוש'],
      rows: [
        [
          'פרטי חשבון וזיהוי',
          'שם משתמש, שם תצוגה, כתובת דוא״ל (חובה בהרשמה), מזהה חשבון, הסיסמה בצורת גיבוב בלבד, אסימוני כניסה ואסימוני איפוס סיסמה בצורת גיבוב, ומועד יצירת החשבון. המשתמש מוסר אותם בהרשמה ובשימוש.',
          'יצירת חשבון, כניסה, אבטחה, שחזור סיסמה ומתן השירות',
        ],
        [
          'מסמכי השימוש',
          'גרסת תנאי השימוש, כללי הקהילה ומדיניות הפרטיות שאושרה או שנקראה, ומועד האישור.',
          'תיעוד ההסכמה ובקשת אישור מחדש כאשר מסמך משתנה',
        ],
        [
          'פרופיל ונמל',
          'הנמל הווירטואלי שנבחר, ואזור הזמן שהמכשיר מוסר לאפליקציה בכל הפעלה. לא נאסף מיקום מדויק.',
          'התאמת חוויית המפה, בחירת נמענים וחישוב שעות היום והלילה של החשבון',
        ],
        [
          'חברים וחסימות',
          'בקשות חברות, רשימת החברים והמשתמשים שחסמת או שחסמו אותך.',
          'קביעה למי אפשר לשלוח מכתב ואכיפת חסימות',
        ],
        [
          'מכתבים ומסעות',
          'טקסט המכתבים והגופן שנבחר, זהויות השולח והנמען, הנמלים, המסלול המדומה, מועדי שליחה, מסירה ופתיחה, תוצאת המסע (הגעה, אבידה, טביעה), פתיחות של בקבוקים ציבוריים ומועדיהן, וההודעות שהשירות יצר עבורך.',
          'הפעלת המסע, הצגת מכתבים למורשים, היסטוריה והתראות',
        ],
        [
          'דיווחים והחלטות',
          'זהות המדווח, סיבת הדיווח והסברו, עותק של המכתב שדווח, המלצת הכלי הממוחשב ונימוקה, החלטת המנהל ונימוקה, ההפרות והערעורים.',
          'טיפול בפגיעה, בדיקת ערעורים והגנה על משתמשים',
        ],
        [
          'נתונים טכניים',
          'כתובת ה-IP משמשת בזיכרון השרת בלבד להגבלת קצב של הרשמה, כניסה ושחזור סיסמה, ואינה נכתבת למסד הנתונים. יומן הבקשות של השרת רושם שיטה, נתיב, קוד תשובה ומשך, ולא כתובת IP. השירות אינו אוסף נתוני דפדפן או מכשיר מלבד אזור הזמן. [[ספק האירוח, פרוקסי או שרת דוא״ל עשויים לשמור יומנים משלהם — להשלים לפי הפריסה]]',
          'אבטחת חשבונות ומניעת ניצול לרעה',
        ],
        [
          'תקשורת עם המפעיל',
          'פניות תמיכה והתכתבות, ככל שיתקבלו ב[[ערוץ פניות — להשלים]].',
          'מענה לפניות וטיפול בבקשות',
        ],
      ],
    },
    {
      type: 'p',
      text: 'השירות אינו מבקש ואינו אוסף מיקום GPS, גישה למצלמה, אנשי קשר, מידע רפואי או פרטי תשלום, ואינו מכיל כלי מדידה, פרסום או ניתוח התנהגות. אם אחד מהם ייאסף בעתיד, נסביר זאת מראש ונעדכן מדיניות זו.',
    },
    { type: 'h2', text: '2. מטרות העיבוד ובסיסו' },
    {
      type: 'p',
      text: 'אנו משתמשים במידע כדי לנהל חשבונות, לשלוח ולהציג מכתבים לזכאים, להפעיל את המפה, לטפל בהתראות, למנוע שימוש לרעה, לבדוק תלונות וערעורים, לאבטח את השירות, להשיב לפניות ולעמוד בחובות חוקיות. [[הבסיס המשפטי המתאים לכל מטרה ולכל מדינת יעד — להשלים לאחר ייעוץ משפטי]] הצגת מדיניות זו למשתמש אינה כשלעצמה הסכמה גורפת לכל שימוש במידע. השירות אינו שולח מסרים שיווקיים ואינו מנהל רשימת דיוור; הודעות הדוא״ל היחידות שהוא שולח הן קישורי שחזור סיסמה שהמשתמש ביקש. אם תתווסף פעילות שיווקית, נבקש לה הסכמה נפרדת שאינה תנאי לשימוש, ונספק דרך לבטלה.',
    },
    { type: 'h2', text: '3. מי עשוי לקרוא מכתב ומי מקבל מידע' },
    {
      type: 'p',
      text: 'השולח רואה את מכתביו ואת רשומות המסע בחשבונו; נמען שהבקבוק הגיע אליו רשאי לפתוח אותו; בקבוק שאבד והופיע במפה הציבורית עשוי להיפתח פעם אחת בידי משתמש אחר, שמקבל חלון קריאה מוגבל. הופעת בקבוק במפה הציבורית מציגה למשתמשים אחרים את מיקומו המדומה ואת מועד האבידה בלבד — לא את השולח, הנמען, הנמלים או הטקסט; טקסט המכתב נחשף רק למי שפתח אותו. צילום מסך או העתקה בידי אדם שקרא מכתב אינם בשליטתנו.',
    },
    {
      type: 'p',
      text: 'מנהל מורשה יכול לצפות במידע הדרוש לבדיקת דיווחים וערעורים, כולל עותק המכתב שדווח; הרשאת המנהל נאכפת בשרת ומוענקת רק בידי מפעיל השירות. כלי ממוחשב המחובר לבדיקת תלונות מעבד מכתבים שדווחו בלבד ומחזיר המלצה, ללא גישה למסד הנתונים וללא סמכות להכריע. הכלי מופעל דרך ממשק שהמפעיל מגדיר, כברירת מחדל על מחשב בשליטתו; [[היכן רץ המודל בפועל בפריסה, האם המכתב שדווח עובר למחשב אחר ומי יכול לגשת אליו — להשלים]]. [[ספקי אירוח, תשתית ודוא״ל שמעבדים מידע בשמנו — לפרט בשמות או בקטגוריות מדויקות, את מטרתם, מיקומם והעברות מחוץ לישראל או לאזור הכלכלי האירופי, לפי הפריסה בפועל]]. מפת השירות מצוירת מנתונים המצורפים לאפליקציה ואינה פונה לשרת מפות חיצוני; [[אם המפעיל יגדיר ספק אריחי מפה חיצוני, הדפדפן יפנה אליו ישירות וכתובת ה-IP תגיע לאותו ספק — לאמת בפריסה]]. מידע עשוי להימסר לרשויות כאשר הדין מחייב זאת או לשם הגנה משפטית מותרת ומידתית.',
    },
    { type: 'h2', text: '4. כמה זמן נשמר המידע' },
    {
      type: 'table',
      head: ['סוג מידע', 'מה השירות עושה היום', 'מה חסר לפני פרסום'],
      rows: [
        [
          'בקבוק אבוד במפה הציבורית',
          'מוצג עד 72 שעות מרגע האבידה, או עד שמשתמש אחר פותח אותו, לפי המוקדם. ההסרה מהמפה אינה מוחקת את המכתב, את רשומת המסע או גיבויים.',
          '—',
        ],
        [
          'קריאה של מוצא בקבוק',
          'קריאה חד פעמית עם אפשרות חזרה של עד 15 דקות. רשומת הפתיחה ומועדיה נשמרות ואין להן מועד מחיקה.',
          '[[לקבוע אם ומתי נמחקות רשומות פתיחה]]',
        ],
        [
          'חשבון, מכתבים והיסטוריית מסע',
          'נשמרים ללא הגבלת זמן. אין כיום מנגנון מחיקת חשבון או מחיקת מכתבים.',
          '[[לקבוע משך שמירה ופעולת מחיקה או אנונימיזציה, בנפרד לחשבון פעיל, סגור וגיבויים]]',
        ],
        [
          'אסימוני כניסה ואיפוס',
          'אסימון כניסה פג לאחר [[30 יום כברירת מחדל — לאמת בפריסה]] או בהתנתקות; אסימון איפוס סיסמה פג לאחר 30 דקות. רשומות אסימונים שפגו אינן נמחקות אוטומטית.',
          '[[לקבוע מועד מחיקה לרשומות אסימונים שפגו]]',
        ],
        [
          'דיווחים, ערעורים וראיות',
          'נשמרים לצורך טיפול, ערעור ואכיפת החלטות. קיים בקוד מנגנון לצמצום עותק המכתב מתיק שהוכרע סופית, והוא מושבת עד שתיקבע מדיניות; הוא לעולם אינו נוגע בתיק פתוח, בערעור תלוי או בהפרה בתוקף.',
          '[[לקבוע תקופת שמירה לתיקים שנדחו ולתיקים שהוכרעו וההפרה בהם בוטלה, ומועד אחרון לערעור]]',
        ],
        [
          'לוגים טכניים, אבטחה, תמיכה',
          'יומן הבקשות של השרת אינו נשמר בידי השירות מעבר לפלט השרת. [[מה שומרים ספק האירוח, הפרוקסי ושרת הדוא״ל — להשלים]]',
          '[[לקבוע תקופות שמירה]]',
        ],
      ],
    },
    {
      type: 'p',
      text: 'הסרה של מכתב מקריאה בתוך האפליקציה, הסרת בקבוק מהמפה הציבורית, הסתרה למי שדיווח ומחיקה ממאגרי המידע הן פעולות שונות. השירות אינו מבטיח מחיקה אוטומטית שלא הוטמעה ונבדקה.',
    },
    { type: 'h2', text: '5. זכויות המשתמש ופניות' },
    {
      type: 'p',
      text: 'ניתן לפנות ל[[כתובת פרטיות — להשלים]] כדי לברר איזה מידע מוחזק לגביך ולבקש עיון, תיקון או מחיקה ככל שזכויות אלה חלות לפי הדין. נוודא את זהות הפונה באופן מידתי, נבחן גם מידע על אנשים אחרים וחובות שמירה החלות עלינו, ונשיב לפי הדין הרלוונטי. נכון לנוסח זה אין בשירות מחיקת חשבון עצמית; בקשת מחיקה מטופלת ידנית דרך ערוץ הפניות, [[ובתהליך שטרם נקבע, כולל טיפול בגיבויים ובקשר שבין מחיקה לבין ראיות של דיווח פתוח]]. הזכויות אינן מחייבות מחיקה של מידע שחובה לשמור כחוק או של עותק חיצוני שכבר שמר מקבל מכתב.',
    },
    { type: 'h2', text: '6. הרשאות מכשיר, אחסון דפדפן ועוגיות' },
    {
      type: 'p',
      text: 'השירות אינו משתמש בעוגיות. בדפדפן נשמרים: אסימון הכניסה, באחסון של הלשונית בלבד (sessionStorage), הנמחק בסגירתה או בהתנתקות; טיוטת מכתב שטרם נשלח, באותו אחסון, הנמחקת בהתנתקות; ואזור הזמן של המכשיר, באחסון מקומי (localStorage), כדי לזהות שינוי בהפעלה הבאה. אין קוד של צד שלישי, כלי מדידה, פיקסלים או פרסום. השירות אינו מבקש גישה למיקום, למצלמה, לאנשי קשר או להתראות מכשיר; ההודעות על מסירה, אבידה או אזהרה מוצגות בתוך האפליקציה בלבד ואינן מסר שיווקי.',
    },
    { type: 'h2', text: '7. אבטחה, צעירים ושינויים' },
    {
      type: 'p',
      text: 'סיסמאות נשמרות כגיבוב scrypt עם מלח ייחודי לכל סיסמה ואינן ניתנות לשחזור; אסימוני כניסה ואיפוס נשמרים כגיבוב בלבד, אסימון איפוס הוא חד פעמי ותקף ל-30 דקות; הרשאות מנהל נאכפות בשרת בכל בקשה. [[הצפנת תעבורה (TLS), הצפנת אחסון, גיבויים ובקרת גישה לשרת — להשלים לפי הפריסה ולציין רק מה שאומת]] אין דרך להבטיח אבטחה מוחלטת; ניתן לדווח על חשד לאירוע אבטחה ל[[כתובת אבטחה — להשלים]]. [[מדיניות הגיל הסופית תופיע כאן לאחר החלטה והטמעה; אם ייקבע שהשירות מיועד לבני 18 ומעלה, יש להסביר כיצד מטפלים בחשבון של קטין שנודע עליו]] לכל גרסה של מדיניות זו יש מספר ומועד תחילה; שינוי מהותי יידרש לאישור מחדש בכניסה הבאה, ולפני עיבוד חדש שדורש זאת נבקש פעולה נפרדת.',
    },
  ],
};

export const POLICY_DOCUMENTS: readonly PolicyDocument[] = [
  TERMS_OF_USE,
  COMMUNITY_GUIDELINES,
  PRIVACY_POLICY,
];

export function policyDocument(id: PolicyId): PolicyDocument {
  return POLICY_DOCUMENTS.find((d) => d.id === id)!;
}

export function currentPolicyVersions(
  docs: readonly PolicyDocument[] = POLICY_DOCUMENTS,
): PolicyVersions {
  const at = (id: PolicyId) => docs.find((d) => d.id === id)!.version;
  return { terms: at('terms'), guidelines: at('guidelines'), privacy: at('privacy') };
}

// The set is released only when every document is.
export function policySetStatus(docs: readonly PolicyDocument[] = POLICY_DOCUMENTS): PolicyStatus {
  return docs.every((d) => d.status === 'released') ? 'released' : 'draft';
}
