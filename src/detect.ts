import type {
  ContentChange, ContentItem, CourseState, EventChange, EventRec, IcalEvent,
} from './types';

/** Ignore events that already ended long ago (e.g. a teacher back-filling old entries). */
const STALE_MS = 3600_000;

export function diffEvents(
  prev: Record<string, EventRec>,
  events: IcalEvent[],
  now: number,
): { changes: EventChange[]; next: Record<string, EventRec> } {
  const changes: EventChange[] = [];
  const next: Record<string, EventRec> = {};
  for (const ev of events) {
    next[ev.uid] = { t: ev.title, s: ev.start, e: ev.end };
    const old = prev[ev.uid];
    const relevant = ev.start >= now - STALE_MS;
    if (!old) {
      if (relevant) changes.push({ kind: 'event', isUpdate: false, ev });
    } else if (old.t !== ev.title || old.s !== ev.start || old.e !== ev.end) {
      if (relevant) changes.push({ kind: 'event', isUpdate: true, ev, oldStart: old.s });
    }
  }
  return { changes, next };
}

export function diffCourse(
  prev: CourseState | undefined,
  courseId: string,
  courseName: string,
  items: ContentItem[],
  now: number,
): { changes: ContentChange[]; next: CourseState } {
  const i: Record<string, string> = {};
  const changes: ContentChange[] = [];
  for (const it of items) {
    i[it.id] = it.hash;
    if (!prev) continue; // first time we see this course: silent baseline
    const old = prev.i[it.id];
    if (old === undefined) {
      changes.push({ kind: 'content', isUpdate: false, courseId, courseName, item: it });
    } else if (old !== it.hash) {
      changes.push({ kind: 'content', isUpdate: true, courseId, courseName, item: it });
    }
  }
  return { changes, next: { n: courseName, c: now, i } };
}
