import type { IcalEvent } from './types';
import { fnv1a, stripTags } from './util';

type Prop = { v: string; p: string[] };

const unescapeText = (s: string): string =>
  s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function parseDate(
  value: string,
  params: string[],
  offsetMin: number,
): { ms: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const allDay = hh === undefined || params.some((p) => p.toUpperCase() === 'VALUE=DATE');
  if (allDay) return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  const utc = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  // "Z" = already UTC (what Moodle exports). Otherwise treat as local time.
  return { ms: z ? utc : utc - offsetMin * 60000, allDay: false };
}

function build(cur: Record<string, Prop>, offsetMin: number, moodleUrl: string): IcalEvent | null {
  const ds = cur['DTSTART'];
  if (!ds) return null;
  const s = parseDate(ds.v, ds.p, offsetMin);
  if (!s) return null;
  const de = cur['DTEND'] ? parseDate(cur['DTEND'].v, cur['DTEND'].p, offsetMin) : null;

  const title = unescapeText(cur['SUMMARY']?.v ?? '(untitled)').trim() || '(untitled)';
  const description = stripTags(unescapeText(cur['DESCRIPTION']?.v ?? ''));
  const course = unescapeText((cur['CATEGORIES']?.v ?? '').split(/(?<!\\),/)[0] ?? '').trim();
  const uid = (cur['UID']?.v ?? '').trim() || fnv1a(title + s.ms);

  const explicitUrl = cur['URL']?.v?.trim();
  const inDesc = /https?:\/\/\S+/.exec(description)?.[0];
  const url =
    explicitUrl ||
    inDesc ||
    `${moodleUrl}/calendar/view.php?view=day&time=${Math.floor(s.ms / 1000)}`;

  return {
    uid,
    title,
    start: s.ms,
    end: de && de.ms > s.ms ? de.ms : s.ms,
    allDay: s.allDay,
    course,
    description,
    url,
  };
}

export function parseIcal(text: string, offsetMin: number, moodleUrl: string): IcalEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: IcalEvent[] = [];
  let cur: Record<string, Prop> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) {
        const ev = build(cur, offsetMin, moodleUrl);
        if (ev) out.push(ev);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    cur[(name ?? '').toUpperCase()] = { v: line.slice(colon + 1), p: params };
  }
  return out;
}
