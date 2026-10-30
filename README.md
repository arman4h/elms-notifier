# eLMS Notifier (Cloudflare Workers + TypeScript)

Checks your Moodle (eLMS) every 15 minutes and tells you about changes:

| Change | Telegram | Linux popup (ntfy) |
|---|---|---|
| New / rescheduled calendar event or deadline | message + **➕ Add to Google Calendar** link | popup with **Add to calendar** button |
| New or updated file / assignment / quiz / link | grouped per course, links to each item | one popup per course |
| Problems (token expired, eLMS unreachable) | one alert after repeated failures | – |

Quiet hours (default 23:00–07:00 Dhaka): messages arrive silently. Events due in <24h are high priority.

```
cron (15 min) → Worker → iCal feed + Moodle API → diff vs state in KV
                              ├→ Telegram Bot API
                              └→ ntfy.sh topic → desktop/ntfy-popup.py → notify-send
```

## Setup (about 15 minutes)

### 1. Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `message.chat.id` → **chat id**.

### 2. Deploy
```bash
npm install
npx wrangler login
npx wrangler kv namespace create STATE        # paste the printed id into wrangler.toml
# edit wrangler.toml: set MOODLE_URL (e.g. https://elms.youruni.edu)

npx wrangler secret put MOODLE_TOKEN          # your Moodle mobile web-service token
npx wrangler secret put ICAL_URL              # your Moodle calendar export URL
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put NTFY_TOPIC            # long random string, e.g. elms-9f3k2x8q7v1m
npx wrangler secret put ADMIN_KEY             # long random string; protects the test URLs

npx wrangler deploy
```

### 3. Verify (replace host and key)
Open these in a browser:

1. `https://elms-notifier.<you>.workers.dev/diag?key=ADMIN_KEY`
   Tests **from Cloudflare's network**: can it fetch the iCal feed? Does the token work? Lists your courses.
   If `ical` or `moodle` shows an error/403, the university is blocking Cloudflare IPs (see Troubleshooting).
2. `/test?key=ADMIN_KEY` — sends a sample deadline to Telegram + ntfy so you can see the format and test the calendar link.
3. `/run?key=ADMIN_KEY&dry=1` — runs a full check without sending or saving anything.
4. `/run?key=ADMIN_KEY` — real first run: takes a **silent baseline** of everything that exists today
   and sends one "✅ live" message. From now on only *changes* notify.

Other endpoints: `/status`, `/reset?confirm=1` (wipe state; next run re-baselines silently).

### 4. Linux popups
```bash
sudo apt install libnotify-bin           # if notify-send is missing
# install ntfy-popup as a user service: see the header of desktop/elms-popup.service
```
Quick test without systemd: `NTFY_TOPIC=your-topic python3 desktop/ntfy-popup.py`, then open `/test` in the browser.
Optional: install the ntfy Android/iOS app and subscribe to the same topic for phone alerts.

## Config (wrangler.toml `[vars]`)
- `COURSE_IDS` – only watch these course ids (get ids from `/diag`). Default: all active enrolled courses.
- `TRACK_CONTENT = "false"` – calendar only (no Moodle API calls).
- `QUIET_START` / `QUIET_END`, `TIMEZONE`, `TZ_OFFSET_HOURS`.

## How it stays within the free plan
Free Workers allow 50 outgoing requests per run and 10 ms CPU. A run uses ~1 (iCal) + 2 (courses) + 1 per course
+ ≤18 notifications + 2 KV calls. A built-in budget (45) defers extra courses to the next run
(least-recently-checked first), and notifications are grouped per course. If you have many courses and see
`deferred > 0` in `/run`, either set `COURSE_IDS` or upgrade to the $5 plan.

## Notes & troubleshooting
- **Privacy:** anyone who knows your ntfy topic can read it. Use a long random topic. Messages contain titles and links only.
  Keep the iCal URL and Moodle token secret (they're stored as Worker secrets, never in code).
- **Blocked by the university:** if `/diag` fails only from Cloudflare, the fallback is running the same code from a Raspberry Pi or
  a Linux machine instead (tell me and I'll add a Node entrypoint).
- **Moodle function not allowed:** if `/diag` says `core_enrol_get_users_courses` (or `core_course_get_contents`) is not available for your token,
  set `TRACK_CONTENT = "false"` for now: the calendar part uses only the iCal feed.
- **Logs:** `npx wrangler tail`. A failure alert is sent after 3 consecutive failed runs (immediately for an invalid token).
- **Read-only:** the Worker never submits anything to Moodle.

## Later: automatic Google Calendar sync
Create a Google service account, share your calendar with it, add its JSON as a secret, and add `src/gcal-api.ts`
(sign a JWT with WebCrypto → insert/update events keyed by the Moodle UID). The "Add to calendar" links can stay as a fallback.
