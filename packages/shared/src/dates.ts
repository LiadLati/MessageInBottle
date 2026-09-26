// Every date and time a person reads in SeaYou, on the web and in server-written text, comes from
// here, in one English style — "26 Oct 2026, 17:35" — whatever the browser's or the operating
// system's language (manual review round 1). The month names are our own: ICU versions disagree
// on English abbreviations ("Sep" or "Sept"), and the output must not depend on the runtime.
// Presentation only: the time zone decides which wall clock is shown (the device's by default, or
// the account zone the server passes); nothing here changes when anything happens.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type When = string | number | Date;

const formats = new Map<string, Intl.DateTimeFormat>();

function partsOf(at: When, timeZone?: string) {
  const key = timeZone ?? '';
  let fmt = formats.get(key);
  if (!fmt) {
    // Numeric parts only, from an explicit locale; the words are added below.
    fmt = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    });
    formats.set(key, fmt);
  }
  const date = at instanceof Date ? at : new Date(at);
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    day: String(Number(p.day)),
    month: MONTHS[Number(p.month) - 1] ?? '',
    year: p.year ?? '',
    time: `${p.hour ?? '00'}:${p.minute ?? '00'}`,
  };
}

/** "26 Oct 2026, 17:35" */
export function formatDateTime(at: When, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.day} ${p.month} ${p.year}, ${p.time}`;
}

/** "26 Oct 2026" */
export function formatDateOnly(at: When, timeZone?: string): string {
  const p = partsOf(at, timeZone);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "17:35" */
export function formatClock(at: When, timeZone?: string): string {
  return partsOf(at, timeZone).time;
}

/** Whether two instants fall on the same calendar day on the given (or the device's) clock. */
export function sameDay(a: When, b: When, timeZone?: string): boolean {
  return formatDateOnly(a, timeZone) === formatDateOnly(b, timeZone);
}
