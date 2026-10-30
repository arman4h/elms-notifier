import { Budget, BudgetExceeded } from './budget';
import { fnv1a } from './util';
import type { Config, ContentItem, State } from './types';

export class MoodleError extends Error {
  code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.code = code;
  }
}

async function call<T>(
  cfg: Config,
  budget: Budget,
  fn: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  if (!budget.take()) throw new BudgetExceeded();
  const body = new URLSearchParams({
    wstoken: cfg.moodleToken,
    wsfunction: fn,
    moodlewsrestformat: 'json',
  });
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));

  const res = await fetch(`${cfg.moodleUrl}/webservice/rest/server.php`, {
    method: 'POST',
    body,
    headers: { 'user-agent': 'elms-notifier/1.0' },
  });
  if (!res.ok) throw new MoodleError(`${fn}: HTTP ${res.status}`, 'http');

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new MoodleError(`${fn}: response was not JSON (blocked or redirected?)`, 'notjson');
  }
  if (data && typeof data === 'object' && 'exception' in data) {
    const d = data as { message?: string; errorcode?: string };
    throw new MoodleError(`${fn}: ${d.message ?? 'Moodle error'}`, d.errorcode ?? 'error');
  }
  return data as T;
}

export interface CourseInfo {
  id: number;
  name: string;
  short: string;
}

interface RawCourse {
  id: number;
  fullname: string;
  shortname: string;
  visible?: number;
  enddate?: number;
}

export async function getSiteInfo(cfg: Config, budget: Budget) {
  return call<{ userid: number; fullname: string; sitename: string }>(
    cfg, budget, 'core_webservice_get_site_info',
  );
}

export async function listCourses(
  cfg: Config,
  budget: Budget,
  state: State,
  now: number,
): Promise<CourseInfo[]> {
  if (!state.uid) state.uid = (await getSiteInfo(cfg, budget)).userid;
  const raw = await call<RawCourse[]>(cfg, budget, 'core_enrol_get_users_courses', {
    userid: state.uid,
  });
  return raw
    .filter((c) =>
      cfg.courseIds
        ? cfg.courseIds.has(String(c.id))
        : c.visible !== 0 && !(c.enddate && c.enddate * 1000 < now),
    )
    .map((c) => ({ id: c.id, name: c.fullname, short: c.shortname }));
}

interface RawModule {
  id: number;
  name: string;
  modname: string;
  url?: string;
  uservisible?: boolean;
  visible?: number;
  contentsinfo?: { lastmodified?: number };
  contents?: { timemodified?: number }[];
}
interface RawSection {
  name?: string;
  modules?: RawModule[];
}

/** Returns a compact list; the large raw JSON is dropped immediately to save CPU/memory. */
export async function getCourseContents(
  cfg: Config,
  budget: Budget,
  courseId: number,
): Promise<ContentItem[]> {
  const sections = await call<RawSection[]>(cfg, budget, 'core_course_get_contents', {
    courseid: courseId,
  });
  const items: ContentItem[] = [];
  for (const sec of sections) {
    for (const m of sec.modules ?? []) {
      if (m.uservisible === false) continue;
      if (m.modname === 'label') continue; // text-only blocks: no title, too noisy
      let modified = m.contentsinfo?.lastmodified ?? 0;
      if (!modified) {
        for (const c of m.contents ?? []) modified = Math.max(modified, c.timemodified ?? 0);
      }
      items.push({
        id: String(m.id),
        name: (m.name ?? '').trim() || '(untitled)',
        type: m.modname,
        url: m.url ?? '',
        section: (sec.name ?? '').trim(),
        hash: fnv1a(`${m.name}|${modified}`),
      });
    }
  }
  return items;
}
