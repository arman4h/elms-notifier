import type { Config, Env } from './types';

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

export function loadConfig(env: Env): Config {
  const ids = (env.COURSE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    moodleUrl: (env.MOODLE_URL ?? '').replace(/\/+$/, ''),
    moodleToken: env.MOODLE_TOKEN ?? '',
    icalUrl: env.ICAL_URL ?? '',
    tgToken: env.TELEGRAM_BOT_TOKEN ?? '',
    tgChat: env.TELEGRAM_CHAT_ID ?? '',
    ntfyServer: (env.NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, ''),
    ntfyTopic: env.NTFY_TOPIC ? env.NTFY_TOPIC : null,
    ntfyToken: env.NTFY_TOKEN ? env.NTFY_TOKEN : null,
    timezone: env.TIMEZONE ?? 'Asia/Dhaka',
    tzOffsetMin: Math.round(num(env.TZ_OFFSET_HOURS, 6) * 60),
    quietStart: num(env.QUIET_START, 23),
    quietEnd: num(env.QUIET_END, 7),
    courseIds: ids.length ? new Set(ids) : null,
    trackContent: (env.TRACK_CONTENT ?? 'true').toLowerCase() !== 'false',
  };
}
