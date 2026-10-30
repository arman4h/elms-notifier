#!/usr/bin/env python3
"""
eLMS desktop popups. Polls your Worker's /outbox every ~30 s and shows each new
notification with notify-send.

  - Click the popup          -> opens the eLMS page
  - "Add to calendar" button -> opens Google Calendar's event editor, pre-filled
  - Messages missed while the PC was off are shown when it comes back.

Needs: python3, notify-send (libnotify-bin), xdg-open. No pip packages.
Environment: ELMS_WORKER_URL (https://<name>.<you>.workers.dev), ELMS_KEY (your ADMIN_KEY)
Optional:    ELMS_POLL_SECONDS (default 30)
"""
import json
import os
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request

BASE = os.environ.get("ELMS_WORKER_URL", "").rstrip("/")
KEY = os.environ.get("ELMS_KEY", "")
POLL = max(10, int(os.environ.get("ELMS_POLL_SECONDS", "30")))
if not BASE or not KEY:
    sys.exit("Set ELMS_WORKER_URL and ELMS_KEY")

CACHE = pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache"))
SINCE_FILE = CACHE / "elms-popup-since"


def load_since():
    try:
        return int(SINCE_FILE.read_text().strip())
    except (OSError, ValueError):
        return None


def save_since(n):
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        SINCE_FILE.write_text(str(n))
    except OSError:
        pass


def fetch(since, max_age):
    url = f"{BASE}/outbox?since={since}&maxAge={max_age}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {KEY}", "User-Agent": "elms-popup/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def open_url(url):
    subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def show(msg):
    title = msg.get("title") or "eLMS"
    body = msg.get("message", "")
    priority = int(msg.get("priority") or 3)
    urgency = "critical" if priority >= 4 else "low" if priority <= 2 else "normal"
    click = msg.get("click")

    base = ["notify-send", "--app-name=eLMS", f"--urgency={urgency}", "--wait", "--expire-time=15000"]
    urls, flags = {}, []
    if click:
        urls["default"] = click
        flags.append("--action=default=Open")
    for i, a in enumerate((msg.get("actions") or [])[:3]):
        if a.get("url"):
            urls[f"a{i}"] = a["url"]
            flags.append(f"--action=a{i}={a.get('label', 'Open')}")

    try:
        res = subprocess.run(base + flags + [title, body], capture_output=True, text=True, timeout=600)
        if res.returncode != 0 and flags:  # old libnotify without --action: plain popup
            subprocess.run(base + [title, body], capture_output=True, text=True, timeout=600)
            return
        chosen = res.stdout.strip()
        if chosen in urls:
            open_url(urls[chosen])
    except (OSError, subprocess.SubprocessError) as e:
        print("notify-send failed:", e, file=sys.stderr)


def main():
    since = load_since()
    delay = POLL
    while True:
        try:
            # first ever run: only show things from the last 30 minutes
            data = fetch(0 if since is None else since, 1800 if since is None else 0)
            latest = int(data.get("latest", 0))
            if since is not None and latest < since:  # server outbox was reset
                since = latest
                save_since(since)
            for m in data.get("msgs", []):
                threading.Thread(target=show, args=(m,), daemon=True).start()
                since = max(since or 0, int(m["id"]))
            if since is None:
                since = latest
            save_since(since)
            delay = POLL
        except Exception as e:
            print(f"poll failed ({e}); retrying in {delay}s", file=sys.stderr)
            delay = min(delay * 2, 300)
        time.sleep(delay)


if __name__ == "__main__":
    main()
