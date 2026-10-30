import { Budget, BudgetExceeded } from './budget';
import { loadConfig } from './config';
import { diffCourse, diffEvents } from './detect';
import { buildNtfy, buildTelegram, isQuiet } from './format';
import { parseIcal } from './ical';
import { getCourseContents, getSiteInfo, listCourses, MoodleError } from './moodle';
import { sendNtfy, sendTelegram } from './notify';
import { pushOutbox, readOutbox } from './outbox';
import type { Change, Config, Env, IcalEvent, State } from './types';
import { errMsg } from './util';

const STATE_KEY = 'state:v1';
const BUDGET_LIMIT = 45;
/** Subrequests kept free for notifications + state write (10 Telegram + 8 ntfy + alerts). */
const SEND_RESERVE = 24;

const emptyState = (): State => ({ v: 1, init: false, ev: {}, co: {}, fails: 0, alerted: false, ok: 0 });

interface RunReport {
  ok: boolean;
  dry: boolean;
  errors: string[];
  firstRun: boolean;
  counts: { events: number; courses: number; checked: number; deferred: number };
  changes: { kind: string; title: string; where?: string; update: boolean }[];
  sent: { telegram: number; outbox: number; ntfy: number };
  subrequests: number;
}

async function fetchIcal(cfg: Config): Promise<IcalEvent[]> {
  const res = await fetch(cfg.icalUrl, { headers: { 'user-agent': 'elms-notifier/1.0' } });
  if (!res.ok) throw new Error(`iCal HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('iCal URL did not return a calendar (expired link, login page or blocked?)');
  }
  return parseIcal(text, cfg.tzOffsetMin, cfg.moodleUrl);
}

export async function runOnce(env: Env, opts: { dry?: boolean } = {}): Promise<RunReport> {
  const cfg = loadConfig(env);
  const dry = !!opts.dry;
  const now = Date.now();
  const budget = new Budget(BUDGET_LIMIT);

  budget.take();
  const raw = await env.STATE.get(STATE_KEY);
  const prev: State = raw ? (JSON.parse(raw) as State) : emptyState();
  const next: State = { ...prev, co: { ...prev.co } };

  const errors: string[] = [];
  const changes: Change[] = [];
  const counts = { events: 0, courses: 0, checked: 0, deferred: 0 };

  // ---- 1) Calendar (iCal feed: 1 request) ----
  try {
    if (!budget.take()) throw new BudgetExceeded();
    const events = await fetchIcal(cfg);
    counts.events = events.length;
    const d = diffEvents(prev.ev, events, now);
    next.ev = d.next;
    if (prev.init) changes.push(...d.changes); // first run = silent baseline
    next.init = true;
  } catch (e) {
    errors.push(`calendar: ${errMsg(e)}`);
  }

  // ---- 2) Course content (Moodle API: 1-3 + 1 per course) ----
  if (cfg.trackContent) {
    try {
      const courses = await listCourses(cfg, budget, next, now);
      counts.courses = courses.length;
      const known = new Set(courses.map((c) => String(c.id)));
      for (const id of Object.keys(next.co)) if (!known.has(id)) delete next.co[id];

      // least-recently-checked first, so a tight budget still rotates fairly
      courses.sort((a, b) => (next.co[String(a.id)]?.c ?? 0) - (next.co[String(b.id)]?.c ?? 0));

      for (const c of courses) {
        if (budget.left <= SEND_RESERVE) {
          counts.deferred++;
          continue;
        }
        try {
          const items = await getCourseContents(cfg, budget, c.id);
          const id = String(c.id);
          const d = diffCourse(next.co[id], id, c.name, items, now);
          next.co[id] = d.next;
          changes.push(...d.changes);
          counts.checked++;
        } catch (e) {
          if (e instanceof MoodleError && e.code === 'invalidtoken') throw e;
          errors.push(`course ${c.short}: ${errMsg(e)}`);
        }
      }
    } catch (e) {
      errors.push(`content: ${errMsg(e)}`);
    }
  }

  // ---- 3) Deliver ----
  const firstRun = !prev.init && next.init;
  const tg = buildTelegram(changes, cfg, now);
  const nt = buildNtfy(changes, cfg, now);
  if (firstRun) {
    const msg = `✅ eLMS notifier is live. Tracking ${counts.events} calendar events and ${counts.courses} courses. I'll message you when something changes.`;
    tg.push(msg);
    nt.push({ topic: cfg.ntfyTopic ?? 'elms', title: '✅ eLMS notifier is live', message: msg, priority: 2 });
  }

  const quiet = isQuiet(cfg, now);
  let okCount = 0;
  const sent = { telegram: 0, outbox: 0, ntfy: 0 };
  if (!dry) {
    for (const t of tg) if (await sendTelegram(cfg, budget, t, quiet)) { okCount++; sent.telegram++; }
    // Desktop popups: our own outbox (reliable), then ntfy as an optional extra.
    if (nt.length && (await pushOutbox(env, budget, nt))) { okCount++; sent.outbox = nt.length; }
    if (cfg.ntfyTopic) for (const p of nt) if (await sendNtfy(cfg, budget, p)) sent.ntfy++;
  }
  const total = tg.length + nt.length;
  const delivered = dry || total === 0 || okCount > 0;
  if (!dry && !delivered) errors.push('delivery: every notification failed (will retry next run)');

  // ---- 4) Persist (only advance state if the user actually got told) ----
  const toSave: State = delivered ? next : { ...prev };
  toSave.fails = errors.length ? prev.fails + 1 : 0;
  toSave.ok = errors.length ? prev.ok : now;

  if (!dry) {
    if (errors.length) {
      const tokenDead = errors.some((m) => /invalidtoken|invalid token/i.test(m));
      if (!prev.alerted && (toSave.fails >= 3 || tokenDead)) {
        const text = `⚠️ <b>eLMS notifier problem</b>\n${errors.map((m) => '• ' + m.replace(/[<>&]/g, '')).join('\n')}`;
        if (await sendTelegram(cfg, budget, text, false)) toSave.alerted = true;
      } else {
        toSave.alerted = prev.alerted;
      }
    } else if (prev.alerted) {
      await sendTelegram(cfg, budget, '✅ eLMS notifier recovered and is working again.', true);
      toSave.alerted = false;
    }
    budget.take();
    await env.STATE.put(STATE_KEY, JSON.stringify(toSave));
  }

  return {
    ok: errors.length === 0,
    dry,
    errors,
    firstRun,
    counts,
    changes: changes.map((c) =>
      c.kind === 'event'
        ? { kind: 'event', title: c.ev.title, where: c.ev.course, update: c.isUpdate }
        : { kind: 'content', title: c.item.name, where: c.courseName, update: c.isUpdate },
    ),
    sent,
    subrequests: budget.spent,
  };
}

// ---------- diagnostics & manual tools (protected by ADMIN_KEY) ----------

async function diag(env: Env) {
  const cfg = loadConfig(env);
  const budget = new Budget(45);
  const out: Record<string, unknown> = {};

  try {
    const res = await fetch(cfg.icalUrl, { headers: { 'user-agent': 'elms-notifier/1.0' } });
    const text = await res.text();
    const events = text.includes('BEGIN:VCALENDAR') ? parseIcal(text, cfg.tzOffsetMin, cfg.moodleUrl) : [];
    out.ical = {
      status: res.status,
      isCalendar: text.includes('BEGIN:VCALENDAR'),
      events: events.length,
      sample: events.slice(0, 3).map((e) => ({ title: e.title, course: e.course, start: new Date(e.start).toISOString(), url: e.url })),
    };
  } catch (e) {
    out.ical = { error: errMsg(e) };
  }

  try {
    const info = await getSiteInfo(cfg, budget);
    const state = emptyState();
    state.uid = info.userid;
    const courses = await listCourses(cfg, budget, state, Date.now());
    out.moodle = { site: info.sitename, user: info.fullname, courses: courses.map((c) => ({ id: c.id, short: c.short, name: c.name })) };
    if (courses.length === 0) {
      out.moodleHint = 'No active courses returned. Courses with a past end date or hidden are skipped; set COURSE_IDS in wrangler.toml to force specific ids.';
    } else {
      try {
        const first = courses[0]!;
        const items = await getCourseContents(cfg, budget, first.id);
        out.contentsTest = {
          course: first.short,
          items: items.length,
          sample: items.slice(0, 5).map((i) => `${i.type}: ${i.name}`),
        };
      } catch (e) {
        out.contentsTest = { error: errMsg(e) };
      }
    }
  } catch (e) {
    out.moodle = { error: errMsg(e) };
  }

  out.config = {
    telegram: !!(cfg.tgToken && cfg.tgChat),
    ntfy: cfg.ntfyTopic ? `${cfg.ntfyServer}/<topic>${cfg.ntfyToken ? ' (authenticated)' : ' (anonymous: shared-IP quota!)'}` : 'disabled',
    timezone: cfg.timezone,
    trackContent: cfg.trackContent,
    courseAllowlist: cfg.courseIds ? [...cfg.courseIds] : 'all active courses',
  };
  return out;
}

async function sendTest(env: Env) {
  const cfg = loadConfig(env);
  const budget = new Budget(10);
  const now = Date.now();
  const ev: IcalEvent = {
    uid: 'test', title: 'Test Assignment 1 is due', course: 'CSE 0000 – Demo Course',
    start: now + 2 * 86400_000, end: now + 2 * 86400_000, allDay: false,
    description: 'This is a test notification.', url: cfg.moodleUrl,
  };
  const changes: Change[] = [{ kind: 'event', isUpdate: false, ev }];
  const tg = buildTelegram(changes, cfg, now);
  const nt = buildNtfy(changes, cfg, now);
  const res: { telegram: boolean; desktopOutbox: boolean; ntfy: boolean | string } = {
    telegram: false, desktopOutbox: false, ntfy: 'disabled',
  };
  for (const t of tg) res.telegram = await sendTelegram(cfg, budget, t, false);
  res.desktopOutbox = await pushOutbox(env, budget, nt);
  if (cfg.ntfyTopic) {
    res.ntfy = false;
    for (const p of nt) res.ntfy = await sendNtfy(cfg, budget, p);
  }
  return res;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json' } });

export default {
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOnce(env)
        .then((r) => console.log(JSON.stringify(r)))
        .catch((e) => console.error('run failed', errMsg(e))),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const provided = url.searchParams.get('key') ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!env.ADMIN_KEY || provided !== env.ADMIN_KEY) {
      return new Response('Not found', { status: 404 });
    }
    switch (url.pathname) {
      case '/diag':
        return json(await diag(env));
      case '/test':
        return json(await sendTest(env));
      case '/run':
        return json(await runOnce(env, { dry: url.searchParams.get('dry') === '1' }));
      case '/status': {
        const raw = await env.STATE.get(STATE_KEY);
        if (!raw) return json({ state: 'empty' });
        const s = JSON.parse(raw) as State;
        return json({
          calendarBaseline: s.init,
          events: Object.keys(s.ev).length,
          courses: Object.values(s.co).map((c) => ({ name: c.n, items: Object.keys(c.i).length, lastChecked: new Date(c.c).toISOString() })),
          lastSuccess: s.ok ? new Date(s.ok).toISOString() : null,
          consecutiveFailures: s.fails,
          quietNow: isQuiet(loadConfig(env), Date.now()),
        });
      }
      case '/outbox': {
        const since = Number(url.searchParams.get('since')) || 0;
        const maxAge = Number(url.searchParams.get('maxAge')) || 0;
        return json(await readOutbox(env, since, maxAge));
      }
      case '/simulate': {
        // Fakes course changes so you can test content notifications:
        // forgets 2 items (they will look NEW) and corrupts 1 hash (looks UPDATED).
        const raw = await env.STATE.get(STATE_KEY);
        if (!raw) return json({ error: 'No state yet. Run /run once first to take the baseline.' });
        const s = JSON.parse(raw) as State;
        const wanted = url.searchParams.get('course');
        const id = wanted && s.co[wanted] ? wanted : Object.keys(s.co).find((k) => Object.keys(s.co[k]!.i).length >= 3);
        if (!id) return json({ error: 'No baselined course with at least 3 items. Check /status.' });
        const course = s.co[id]!;
        const ids = Object.keys(course.i);
        const removed = ids.slice(0, 2);
        for (const m of removed) delete course.i[m];
        const changed = ids[2]!;
        course.i[changed] = 'simulated-old-hash';
        await env.STATE.put(STATE_KEY, JSON.stringify(s));
        return json({ course: course.n, willAppearAsNew: removed.length, willAppearAsUpdated: 1, next: 'Now open /run?key=... and you should get a notification.' });
      }
      case '/reset':
        if (url.searchParams.get('confirm') !== '1') return json({ hint: 'add &confirm=1 to wipe state (next run = silent baseline)' });
        await env.STATE.delete(STATE_KEY);
        return json({ reset: true });
      default:
        return json({ endpoints: ['/diag', '/test', '/run?dry=1', '/run', '/status', '/outbox', '/simulate', '/reset?confirm=1'] });
    }
  },
};
