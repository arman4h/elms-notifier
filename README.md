# eLMS Notifier

Watches your university Moodle (eLMS) and tells you when something changes:

| What changed | Telegram | Linux desktop popup |
|---|---|---|
| New or rescheduled calendar event / deadline | Message with a **➕ Add to Google Calendar** link | Popup with an **Add to calendar** button |
| New or updated file, assignment, quiz, link, folder | One message per course, linking each item | One popup per course |
| Problems (token expired, eLMS unreachable) | One alert after repeated failures | – |

Extras: silent messages during quiet hours (default 23:00–07:00 Dhaka time), high priority for deadlines due in under 24 hours,
and the Worker never writes anything to Moodle (read-only).

## How it works

```
Cloudflare cron (every 15 min)
        │
        ▼
 Cloudflare Worker (TypeScript)
   ├─ reads your iCal feed            → calendar events
   ├─ calls the Moodle web-service API → course contents
   ├─ compares with what it saw last time (stored in Workers KV)
   └─ for each change:
        ├─ Telegram Bot API ───────────────→ your phone / Telegram Desktop
        └─ outbox (KV) ◀── polled every 30 s by linux-notify/popup.py ──→ notify-send popup
```

Everything runs on the free Cloudflare plan. Only the popup script runs on your own computer.

## Requirements

- A Cloudflare account (free): https://dash.cloudflare.com/sign-up
- Node.js 18+ and npm on the machine you deploy from
- A Telegram account
- Your eLMS login, with the **mobile web service** enabled (most Moodle sites have it)
- Linux with a desktop session, `python3`, and `notify-send` (package `libnotify-bin`) for the popups

## Setup

### 1. Install the project

```bash
unzip elms-notifier.zip
cd elms-notifier
npm install
```

### 2. Create the Telegram bot

1. In Telegram open **@BotFather**, send `/newbot`, follow the prompts, and copy the **bot token** (looks like `123456789:AAF...`).
2. Open a chat with your new bot and send it any message (for example "hi").
3. Open this URL in a browser, with your token in place of `<TOKEN>`:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Find `"chat":{"id":123456789,...}`. That number is your **chat id**.

### 3. Get your Moodle token

Run this in a terminal (POST keeps your password out of browser history). Replace the domain, username and password:

```bash
curl -s -X POST "https://YOUR-ELMS-DOMAIN/login/token.php" \
  -d "username=YOUR_USERNAME" \
  --data-urlencode "password=YOUR_PASSWORD" \
  -d "service=moodle_mobile_app"
```

The reply contains `{"token":"a1b2c3...","privatetoken":"..."}`. Keep the value of `token`.
(If your university uses SSO and this fails, look under *Profile → Preferences → Security keys* in eLMS.)

Test it:

```bash
curl -s -X POST "https://YOUR-ELMS-DOMAIN/webservice/rest/server.php" \
  -d "wstoken=YOUR_TOKEN" -d "wsfunction=core_webservice_get_site_info" -d "moodlewsrestformat=json"
```

You should see your name and the site name.

### 4. Get your calendar (iCal) URL

In eLMS: **Calendar → Import or export calendars → Export calendar**.
Choose **All courses** and **Recent and next 60 days** (or a custom range), click **Get calendar URL**, and copy the long link.
Treat it like a password.

### 5. Log in to Cloudflare and create storage

```bash
npx wrangler login
npx wrangler kv namespace create STATE
```

The second command prints a block containing `id = "..."`. Copy that id.

### 6. Edit `wrangler.toml`

- Replace `REPLACE_WITH_KV_NAMESPACE_ID` with the id from step 5 (keep the quotes and keep `binding = "STATE"`).
- Set `MOODLE_URL` to your eLMS address, for example `https://elms.youruni.edu` (no trailing slash, no `/login`).
- Adjust `TIMEZONE`, `TZ_OFFSET_HOURS`, `QUIET_START` and `QUIET_END` if you like.

### 7. Set the secrets

Run these one at a time. Each asks for a value; paste it and press Enter (the text stays hidden, which is normal).
Don't type quotes or the variable name.

```bash
npx wrangler secret put MOODLE_TOKEN          # from step 3
npx wrangler secret put ICAL_URL              # from step 4, the full https://... link
npx wrangler secret put TELEGRAM_BOT_TOKEN    # from step 2
npx wrangler secret put TELEGRAM_CHAT_ID      # from step 2
npx wrangler secret put ADMIN_KEY             # a long random string, see below
```

Generate a random value for `ADMIN_KEY` with `openssl rand -hex 16` and **save it somewhere safe**.
It protects the test URLs and is also what the Linux popup script uses to read its outbox.

Optional (not needed for popups): `NTFY_TOPIC` and `NTFY_TOKEN` also publish to an ntfy.sh topic for phone push.
ntfy.sh can reject requests from Cloudflare, so don't rely on it. If it fails, nothing else is affected.

Check the names were saved: `npx wrangler secret list`.

### 8. Deploy

```bash
npx wrangler deploy
```

It prints your Worker address, like `https://elms-notifier.<your-subdomain>.workers.dev`.
The cron trigger (every 15 minutes) is created automatically.

### 9. Verify

Open these in a browser (replace the address and use your `ADMIN_KEY`):

1. `/diag?key=ADMIN_KEY`
   Checks, **from Cloudflare's network**, that the iCal URL answers (`ical.status` should be 200 and `events` above 0),
   that your token works, and lists your courses and a sample of one course's contents.
2. `/test?key=ADMIN_KEY`
   Sends a sample deadline. Expect `"telegram": true` and `"desktopOutbox": true`, and a Telegram message with the
   **Add to Google Calendar** link.
3. `/run?key=ADMIN_KEY&dry=1`
   A full check that sends and saves nothing. Shows what it would have reported, plus any errors.
4. `/run?key=ADMIN_KEY`
   The first real run. It records everything that exists **silently**, then sends one "✅ eLMS notifier is live" message.
   From now on only changes are reported.

### 10. Linux popups

On the Linux computer where you want popups:

```bash
sudo apt install libnotify-bin
notify-send "Test" "Hello"                 # you should see a popup
```

Install the script as a background service (run from the project folder):

```bash
mkdir -p ~/.local/share/elms-popup ~/.config/systemd/user
cp linux-notify/popup.py ~/.local/share/elms-popup/
cp linux-notify/elms-popup.service ~/.config/systemd/user/

printf 'ELMS_WORKER_URL=https://elms-notifier.<your-subdomain>.workers.dev\nELMS_KEY=<your ADMIN_KEY>\n' > ~/.config/elms-popup.env
chmod 600 ~/.config/elms-popup.env

systemctl --user daemon-reload
systemctl --user enable --now elms-popup
systemctl --user --no-pager status elms-popup
```

Open `/test?key=ADMIN_KEY` again; a popup should appear within 30 to 60 seconds.

Useful commands:

```bash
journalctl --user -u elms-popup -f             # live logs
systemctl --user restart elms-popup            # after editing ~/.config/elms-popup.env
systemctl --user disable --now elms-popup      # uninstall
```

Run it by hand for debugging:

```bash
systemctl --user stop elms-popup
set -a; . ~/.config/elms-popup.env; set +a
python3 ~/.local/share/elms-popup/popup.py
```

Notes:
- Messages that arrived while your PC was off or asleep are shown when it comes back (the outbox keeps the last 40, for 3 days).
- The **Add to calendar** button needs `notify-send` 0.7.10 or newer (`notify-send --version`). Older versions show a plain popup;
  use the Telegram links instead.
- Delay: popups appear within about a minute of the Worker's run, because the script polls every 30 s.

## Testing course-content notifications

Course content is reported only after a course has a baseline, so the first run is silent by design.

1. `/run?key=ADMIN_KEY` once (baseline).
2. `/status?key=ADMIN_KEY` should list your courses with item counts.
3. `/simulate?key=ADMIN_KEY` makes the Worker forget 2 items and mark 1 as changed in one course.
4. `/run?key=ADMIN_KEY` now reports "2 new, 1 updated" on Telegram and as a popup.

If `/status` lists no courses, check `/diag`: `moodle.error`, `moodleHint` and `contentsTest` explain why
(for example the university has not allowed `core_course_get_contents` for the mobile token).

## Endpoints

All need `?key=ADMIN_KEY` (or an `Authorization: Bearer ADMIN_KEY` header). Anything else returns "Not found".

| Path | What it does |
|---|---|
| `/diag` | Connectivity and token checks, lists your courses |
| `/test` | Sends a sample deadline to Telegram and the desktop outbox |
| `/run?dry=1` | Full check without sending or saving |
| `/run` | Full check now (the cron does this every 15 min) |
| `/status` | Baseline state, items per course, last success, failure count |
| `/outbox?since=N` | Desktop notifications newer than id N (used by `popup.py`) |
| `/simulate` | Fakes course changes for testing |
| `/reset?confirm=1` | Wipes saved state; the next run silently re-baselines |

## Configuration (`wrangler.toml` → `[vars]`)

| Variable | Default | Meaning |
|---|---|---|
| `MOODLE_URL` | – | Your eLMS address |
| `TIMEZONE` / `TZ_OFFSET_HOURS` | `Asia/Dhaka` / `6` | Display time zone; offset used for local times and quiet hours |
| `QUIET_START` / `QUIET_END` | `23` / `7` | Silent notifications between these hours |
| `TRACK_CONTENT` | `true` | `false` = calendar only, no Moodle API calls |
| `COURSE_IDS` | all active courses | Comma-separated allowlist (ids are listed by `/diag`) |
| `NTFY_SERVER` | `https://ntfy.sh` | Only used if you set `NTFY_TOPIC` |

The schedule lives under `[triggers] crons` (UTC). Fifteen minutes is a good balance.

## Free-plan limits

Free Workers allow 50 outgoing requests and 10 ms of CPU per run. A run needs about: 1 (iCal) + 2 (user and course list)
+ 1 per course + notifications + a few storage calls. A built-in budget keeps it under the limit, checks the
least-recently-checked courses first, and groups notifications per course. If `/run` shows `deferred` above 0,
set `COURSE_IDS` to the courses you care about, or use the paid plan.

## Updating the code

After changing files in `src/`:

```bash
npx wrangler deploy
```

When installing a newer zip over an existing project, copy only `src/` and `linux-notify/`, and **don't overwrite `wrangler.toml`**
(it holds your KV id and eLMS address). Secrets stay in Cloudflare and are unaffected.
If `linux-notify/popup.py` changed, copy it to `~/.local/share/elms-popup/` and restart the service.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `/diag` shows `ical.status` 522 or another error | The iCal link timed out or is wrong. Check it with `curl -sI "URL"` on your PC and re-set `ICAL_URL`. If it works for you but not from Cloudflare, the calendar can be read through the Moodle API instead (not built yet). |
| `/diag` `moodle.error` mentions `invalidtoken` | Token wrong or expired. Get a new one (step 3) and re-run `npx wrangler secret put MOODLE_TOKEN`. |
| `moodle.error` says a function is not available | The university has not allowed it for the mobile token. Set `TRACK_CONTENT = "false"` for calendar-only. |
| `/status` lists no courses | Course content has no baseline yet, or `/diag` shows why. Run `/run` once. |
| `/test` shows `"telegram": false` | Wrong bot token or chat id, or you never sent your bot a message. |
| `/test` shows `"desktopOutbox": false` | Worker storage error; see `npx wrangler tail`. |
| No popup though `/test` says `desktopOutbox: true` | `journalctl --user -u elms-popup -n 30 --no-pager`. `HTTP Error 404` = wrong key or URL in `~/.config/elms-popup.env`, or the Worker was not redeployed. |
| `ntfy failed 429` / `522` | ntfy.sh limits or blocks shared Cloudflare IPs. Ignore it: remove `NTFY_TOPIC` with `npx wrangler secret delete NTFY_TOPIC`. |
| `Not found` on every URL | Wrong or missing `?key=`. |
| Many messages on the very first run | Shouldn't happen (baseline is silent). Use `/reset?confirm=1`, then `/run` once. |

Live logs: `npx wrangler tail`.

## Security

- Treat the Moodle token, iCal URL, Telegram bot token and `ADMIN_KEY` like passwords. They live only in Cloudflare secrets
  and in `~/.config/elms-popup.env` (mode 600). Never put them in code, screenshots, chats or git.
- If any value leaks (including an `ADMIN_KEY` in a pasted URL), replace it: `npx wrangler secret put NAME`.
  For the Moodle token, change your eLMS password and fetch a new token. If you rotate `ADMIN_KEY`, update `~/.config/elms-popup.env`
  and restart the popup service.
- The Worker only reads from Moodle. Keep it that way: don't automate submissions or quizzes.
- Don't use this against anything other than your own account, and keep the polling gentle.

## Project layout

```
elms-notifier/
├── wrangler.toml          # schedule, KV binding, settings
├── src/
│   ├── index.ts           # cron + admin endpoints, main run logic
│   ├── ical.ts            # calendar feed parser
│   ├── moodle.ts          # Moodle API client
│   ├── detect.ts          # change detection
│   ├── format.ts          # Telegram / popup message building
│   ├── gcal.ts            # "Add to Google Calendar" links
│   ├── notify.ts          # Telegram + optional ntfy senders
│   ├── outbox.ts          # desktop notification queue
│   └── config.ts, types.ts, budget.ts, util.ts
└── linux-notify/
    ├── popup.py           # desktop popup poller (stdlib only)
    └── elms-popup.service # systemd user service
```

## Ideas for later

- Announcement and forum-post tracking, and grade-change alerts.
- Reading the calendar through the Moodle API instead of the iCal link.
- Automatic Google Calendar sync: create a Google service account, share your calendar with it, store its JSON as a secret,
  and add a module that inserts or updates events keyed by the Moodle event id. The "Add to calendar" links can stay as a fallback.