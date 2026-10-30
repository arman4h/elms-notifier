import { googleCalendarLink } from './gcal';
import type { Change, Config, ContentChange, EventChange } from './types';
import { esc, truncate } from './util';

export interface NtfyPayload {
  topic: string;
  title: string;
  message: string;
  click?: string;
  priority?: number;
  tags?: string[];
  actions?: { action: 'view'; label: string; url: string; clear?: boolean }[];
}

// ---------- helpers ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', opts);
    fmtCache.set(key, f);
  }
  return f;
}

export function fmtWhen(ev: { start: number; allDay: boolean }, cfg: Config): string {
  if (ev.allDay) {
    const f = formatter('day', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    return `${f.format(new Date(ev.start))} (all day)`;
  }
  const f = formatter('tz:' + cfg.timezone, {
    timeZone: cfg.timezone, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return f.format(new Date(ev.start));
}

export function relTime(target: number, now: number): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const label = m < 60 ? `${m} min` : h < 48 ? `${h} h` : `${d} days`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

export function isQuiet(cfg: Config, now: number): boolean {
  const h = new Date(now + cfg.tzOffsetMin * 60000).getUTCHours();
  const { quietStart: s, quietEnd: e } = cfg;
  if (s === e) return false;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

const eventEmoji = (t: string): string =>
  /quiz|exam|test|midterm|final/i.test(t) ? '❓'
  : /assign|submi|due|report|project|lab/i.test(t) ? '📝'
  : '🗓';

const TYPE_EMOJI: Record<string, string> = {
  resource: '📄', folder: '📁', url: '🔗', assign: '📝', quiz: '❓', forum: '💬',
  page: '📃', book: '📚', lesson: '📖', zoom: '🎥', bigbluebuttonbn: '🎥',
  h5pactivity: '🧩', scorm: '🧩', workshop: '🛠', choice: '🗳', feedback: '🗒',
};
const typeEmoji = (t: string): string => TYPE_EMOJI[t] ?? '📌';

const isUrgent = (ev: { start: number }, now: number): boolean =>
  ev.start > now && ev.start - now < 24 * 3600_000;

function chunk(header: string, blocks: string[], limit = 3800): string[] {
  const out: string[] = [];
  let cur = header;
  for (const b of blocks) {
    if (cur !== header && cur.length + b.length + 2 > limit) {
      out.push(cur);
      cur = header;
    }
    cur += '\n\n' + b;
  }
  out.push(cur);
  return out;
}

function groupByCourse(list: ContentChange[]): Map<string, ContentChange[]> {
  const g = new Map<string, ContentChange[]>();
  for (const c of list) {
    const arr = g.get(c.courseId) ?? [];
    arr.push(c);
    g.set(c.courseId, arr);
  }
  return g;
}

const counts = (list: ContentChange[]): string => {
  const nNew = list.filter((c) => !c.isUpdate).length;
  const nUpd = list.length - nNew;
  const parts: string[] = [];
  if (nNew) parts.push(`${nNew} new`);
  if (nUpd) parts.push(`${nUpd} updated`);
  return parts.join(', ');
};

// ---------- Telegram ----------

function tgEventBlock(c: EventChange, cfg: Config, now: number): string {
  const ev = c.ev;
  const lines = [
    `${eventEmoji(ev.title)} <b>${esc(ev.title)}</b>${c.isUpdate ? ' <i>(updated)</i>' : ''}`,
  ];
  const when = `${fmtWhen(ev, cfg)} · ${relTime(ev.start, now)}`;
  lines.push(`${ev.course ? esc(ev.course) + ' · ' : ''}${esc(when)}`);
  if (c.isUpdate && c.oldStart !== undefined && c.oldStart !== ev.start) {
    lines.push(`<i>was ${esc(fmtWhen({ start: c.oldStart, allDay: ev.allDay }, cfg))}</i>`);
  }
  lines.push(
    `<a href="${esc(googleCalendarLink(ev, cfg.timezone))}">➕ Add to Google Calendar</a>` +
      ` · <a href="${esc(ev.url)}">Open in eLMS</a>`,
  );
  return lines.join('\n');
}

function tgContentMessage(list: ContentChange[]): string {
  const first = list[0]!;
  const lines = list.slice(0, 15).map((c) => {
    const name = esc(truncate(c.item.name, 80));
    const label = c.item.url ? `<a href="${esc(c.item.url)}">${name}</a>` : name;
    const sec = c.item.section ? ` <i>· ${esc(truncate(c.item.section, 30))}</i>` : '';
    return `${typeEmoji(c.item.type)} ${label}${c.isUpdate ? ' <i>(updated)</i>' : ''}${sec}`;
  });
  if (list.length > 15) lines.push(`…and ${list.length - 15} more`);
  return `📚 <b>${esc(first.courseName)}</b> — ${counts(list)}\n${lines.join('\n')}`;
}

export function buildTelegram(changes: Change[], cfg: Config, now: number, max = 10): string[] {
  const events = changes.filter((c): c is EventChange => c.kind === 'event');
  const content = changes.filter((c): c is ContentChange => c.kind === 'content');
  const out: string[] = [];

  if (events.length) {
    const sorted = [...events].sort((a, b) => a.ev.start - b.ev.start);
    out.push(
      ...chunk(
        `🗓 <b>eLMS calendar</b> — ${events.length} ${events.length === 1 ? 'change' : 'changes'}`,
        sorted.map((c) => tgEventBlock(c, cfg, now)),
      ),
    );
  }
  for (const list of groupByCourse(content).values()) out.push(tgContentMessage(list));

  if (out.length > max) {
    const hidden = out.length - (max - 1);
    return [
      ...out.slice(0, max - 1),
      `…plus ${hidden} more message(s) of changes. <a href="${esc(cfg.moodleUrl)}">Open eLMS</a>`,
    ];
  }
  return out;
}

// ---------- ntfy (Linux popup + phone) ----------

export function buildNtfy(changes: Change[], cfg: Config, now: number, max = 8): NtfyPayload[] {
  const topic = cfg.ntfyTopic ?? 'elms';
  const quiet = isQuiet(cfg, now);
  const out: NtfyPayload[] = [];

  const events = changes
    .filter((c): c is EventChange => c.kind === 'event')
    .sort((a, b) => a.ev.start - b.ev.start);
  const content = changes.filter((c): c is ContentChange => c.kind === 'content');

  const MAX_EVENT_POPUPS = 5;
  for (const c of events.slice(0, MAX_EVENT_POPUPS)) {
    const ev = c.ev;
    const urgent = isUrgent(ev, now);
    out.push({
      topic,
      title: `${urgent ? '⏰ ' : ''}${eventEmoji(ev.title)} ${ev.title}${c.isUpdate ? ' (updated)' : ''}`,
      message: `${ev.course ? ev.course + '\n' : ''}${fmtWhen(ev, cfg)} · ${relTime(ev.start, now)}`,
      click: ev.url,
      priority: quiet ? 2 : urgent ? 4 : 3,
      tags: ['calendar'],
      actions: [
        { action: 'view', label: '➕ Add to calendar', url: googleCalendarLink(ev, cfg.timezone), clear: true },
        { action: 'view', label: 'Open eLMS', url: ev.url },
      ],
    });
  }
  if (events.length > MAX_EVENT_POPUPS) {
    const rest = events.slice(MAX_EVENT_POPUPS);
    out.push({
      topic,
      title: `🗓 +${rest.length} more calendar changes`,
      message: rest.slice(0, 10).map((c) => `• ${truncate(c.ev.title, 60)} (${fmtWhen(c.ev, cfg)})`).join('\n'),
      click: `${cfg.moodleUrl}/calendar/view.php?view=upcoming`,
      priority: quiet ? 2 : 3,
      tags: ['calendar'],
    });
  }

  for (const list of groupByCourse(content).values()) {
    const first = list[0]!;
    const lines = list.slice(0, 8).map((c) => `• ${truncate(c.item.name, 70)}${c.isUpdate ? ' (updated)' : ''}`);
    if (list.length > 8) lines.push(`…and ${list.length - 8} more`);
    const link = list.find((c) => c.item.url)?.item.url;
    out.push({
      topic,
      title: `📚 ${first.courseName} — ${counts(list)}`,
      message: lines.join('\n'),
      click: link,
      priority: quiet ? 2 : 3,
      tags: ['books'],
      actions: link ? [{ action: 'view', label: 'Open in eLMS', url: link }] : undefined,
    });
  }

  if (out.length > max) {
    const hidden = out.length - (max - 1);
    return [
      ...out.slice(0, max - 1),
      { topic, title: `…plus ${hidden} more notifications`, message: 'Check Telegram or eLMS.', click: cfg.moodleUrl, priority: 3 },
    ];
  }
  return out;
}
