import type { Budget } from './budget';
import type { NtfyPayload } from './format';
import type { Env } from './types';
import { errMsg } from './util';

/**
 * A tiny queue of desktop notifications kept in KV. The Linux popup script polls
 * GET /outbox?since=<id> and shows whatever is new. No third-party service involved.
 */
const KEY = 'outbox:v1';
const KEEP = 40;
const MAX_AGE_MS = 3 * 86400_000;

export interface OutboxMsg {
  id: number;
  t: number;
  title: string;
  message: string;
  click?: string;
  priority?: number;
  actions?: { label: string; url: string }[];
}
interface Outbox {
  seq: number;
  msgs: OutboxMsg[];
}

export async function pushOutbox(env: Env, budget: Budget, payloads: NtfyPayload[]): Promise<boolean> {
  if (!payloads.length) return true;
  if (!budget.take(2)) return false; // 1 read + 1 write
  try {
    const raw = await env.STATE.get(KEY);
    const box: Outbox = raw ? (JSON.parse(raw) as Outbox) : { seq: 0, msgs: [] };
    const now = Date.now();
    for (const p of payloads) {
      box.seq++;
      box.msgs.push({
        id: box.seq,
        t: now,
        title: p.title,
        message: p.message,
        click: p.click,
        priority: p.priority,
        actions: p.actions?.map((a) => ({ label: a.label, url: a.url })),
      });
    }
    box.msgs = box.msgs.filter((m) => now - m.t < MAX_AGE_MS).slice(-KEEP);
    await env.STATE.put(KEY, JSON.stringify(box));
    return true;
  } catch (e) {
    console.error('outbox error', errMsg(e));
    return false;
  }
}

export async function readOutbox(
  env: Env,
  since: number,
  maxAgeSec: number,
): Promise<{ latest: number; msgs: OutboxMsg[] }> {
  const raw = await env.STATE.get(KEY);
  if (!raw) return { latest: 0, msgs: [] };
  const box = JSON.parse(raw) as Outbox;
  const minT = maxAgeSec > 0 ? Date.now() - maxAgeSec * 1000 : 0;
  return { latest: box.seq, msgs: box.msgs.filter((m) => m.id > since && m.t >= minT) };
}
