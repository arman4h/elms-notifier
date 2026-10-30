export interface Env {
  STATE: KVNamespace;
  // plain vars (wrangler.toml)
  MOODLE_URL: string;
  NTFY_SERVER?: string;
  TIMEZONE?: string;
  TZ_OFFSET_HOURS?: string;
  QUIET_START?: string;
  QUIET_END?: string;
  COURSE_IDS?: string;
  TRACK_CONTENT?: string;
  // secrets (wrangler secret put)
  MOODLE_TOKEN: string;
  ICAL_URL: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  NTFY_TOPIC?: string;
  NTFY_TOKEN?: string;
  ADMIN_KEY: string;
}

export interface Config {
  moodleUrl: string;
  moodleToken: string;
  icalUrl: string;
  tgToken: string;
  tgChat: string;
  ntfyServer: string;
  ntfyTopic: string | null;
  ntfyToken: string | null;
  timezone: string;
  tzOffsetMin: number;
  quietStart: number;
  quietEnd: number;
  courseIds: Set<string> | null;
  trackContent: boolean;
}

export interface IcalEvent {
  uid: string;
  title: string;
  /** epoch ms (for all-day events: UTC midnight of that date) */
  start: number;
  end: number;
  allDay: boolean;
  course: string;
  description: string;
  /** link back to eLMS (always set) */
  url: string;
}

export interface ContentItem {
  id: string;
  name: string;
  /** Moodle modname: resource, assign, quiz, url, folder, ... */
  type: string;
  url: string;
  section: string;
  hash: string;
}

export interface EventChange {
  kind: 'event';
  isUpdate: boolean;
  ev: IcalEvent;
  oldStart?: number;
}

export interface ContentChange {
  kind: 'content';
  isUpdate: boolean;
  courseId: string;
  courseName: string;
  item: ContentItem;
}

export type Change = EventChange | ContentChange;

/** Everything is kept in ONE KV key so a run costs 1 read + 1 write. */
export interface EventRec { t: string; s: number; e: number }
export interface CourseState {
  /** course name */
  n: string;
  /** last checked (epoch ms) */
  c: number;
  /** module id -> hash */
  i: Record<string, string>;
}
export interface State {
  v: 1;
  /** calendar baseline taken */
  init: boolean;
  uid?: number;
  ev: Record<string, EventRec>;
  co: Record<string, CourseState>;
  fails: number;
  alerted: boolean;
  ok: number;
}
