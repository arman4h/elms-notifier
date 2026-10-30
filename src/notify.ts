import type { Budget } from './budget';
import type { NtfyPayload } from './format';
import type { Config } from './types';
import { errMsg } from './util';

export async function sendTelegram(
  cfg: Config,
  budget: Budget,
  text: string,
  silent = false,
): Promise<boolean> {
  if (!cfg.tgToken || !cfg.tgChat) return false;
  if (!budget.take()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.tgChat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
    });
    if (!res.ok) {
      console.error('telegram failed', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('telegram error', errMsg(e));
    return false;
  }
}

export async function sendNtfy(cfg: Config, budget: Budget, payload: NtfyPayload): Promise<boolean> {
  if (!cfg.ntfyTopic) return false;
  if (!budget.take()) return false;
  try {
    const res = await fetch(`${cfg.ntfyServer}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Logged-in publishing is counted per account, not per (shared) Cloudflare IP.
        ...(cfg.ntfyToken ? { authorization: `Bearer ${cfg.ntfyToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error('ntfy failed', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error('ntfy error', errMsg(e));
    return false;
  }
}
