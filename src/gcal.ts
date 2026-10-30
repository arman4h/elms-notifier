import type { IcalEvent } from './types';
import { truncate } from './util';

const fmtUtc = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * "Add to Google Calendar" link. Opens Google Calendar's event editor pre-filled,
 * so one tap + Save is all that's needed. No API access required.
 */
export function googleCalendarLink(ev: IcalEvent, tz: string, defaultMinutes = 30): string {
  let dates: string;
  if (ev.allDay) {
    const endEx = ev.end > ev.start ? ev.end : ev.start + 86400000;
    dates = `${fmtDay(ev.start)}/${fmtDay(endEx)}`;
  } else {
    const end = ev.end > ev.start ? ev.end : ev.start + defaultMinutes * 60000;
    dates = `${fmtUtc(ev.start)}/${fmtUtc(end)}`;
  }

  const make = (detailsLen: number): string => {
    const parts = [ev.course, detailsLen ? truncate(ev.description, detailsLen) : '', ev.url].filter(Boolean);
    const p = new URLSearchParams({
      action: 'TEMPLATE',
      text: ev.title,
      dates,
      ctz: tz,
      details: parts.join('\n'),
    });
    return `https://calendar.google.com/calendar/render?${p.toString()}`;
  };

  // Keep links short enough for Telegram / ntfy.
  for (const len of [400, 150, 0]) {
    const link = make(len);
    if (link.length <= 1800) return link;
  }
  return make(0);
}
