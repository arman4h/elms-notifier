#!/usr/bin/env python3
"""
Show eLMS notifications (sent through ntfy) as native Linux desktop popups.

- Click the popup            -> opens the eLMS page
- "Add to calendar" button   -> opens Google Calendar's event editor, pre-filled
- Catches up on messages missed while the machine was off/asleep (ntfy keeps ~12h).

Needs: python3, notify-send (libnotify-bin), xdg-open. No pip packages.
Config via environment: NTFY_TOPIC (required), NTFY_SERVER (default https://ntfy.sh)
"""
import json
import os
import pathlib
import subprocess
import sys
import threading
import time
import urllib.request

SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
TOPIC = os.environ.get("NTFY_TOPIC")
if not TOPIC:
    sys.exit("NTFY_TOPIC is not set")

CACHE = pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache"))
LAST_ID_FILE = CACHE / "elms-popup-last-id"


def load_since() -> str:
    try:
        return LAST_ID_FILE.read_text().strip() or "30m"
    except OSError:
        return "30m"


def save_last_id(mid: str) -> None:
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        LAST_ID_FILE.write_text(mid)
    except OSError:
        pass


def open_url(url: str) -> None:
    subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def show(msg: dict) -> None:
    title = msg.get("title") or "eLMS"
    body = msg.get("message", "")
    priority = int(msg.get("priority", 3))
    urgency = "critical" if priority >= 4 else "low" if priority <= 2 else "normal"
    click = msg.get("click")
    actions = [a for a in msg.get("actions", []) if a.get("action") == "view" and a.get("url")]

    base = ["notify-send", "--app-name=eLMS", f"--urgency={urgency}", "--wait", "--expire-time=15000"]
    action_urls = {}
    flags = []
    if click:
        action_urls["default"] = click
        flags.append("--action=default=Open")
    for i, a in enumerate(actions[:3]):
        key = f"a{i}"
        action_urls[key] = a["url"]
        flags.append(f"--action={key}={a.get('label', 'Open')}")

    def run(cmd):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=600)

    try:
        res = run(base + flags + [title, body])
        if res.returncode != 0 and flags:  # old libnotify without --action support
            run(base + [title, body])  # old libnotify: plain popup, no buttons
            return
        chosen = res.stdout.strip()
        if chosen in action_urls:
            open_url(action_urls[chosen])
    except (OSError, subprocess.SubprocessError) as e:
        print("notify-send failed:", e, file=sys.stderr)


def listen() -> None:
    url = f"{SERVER}/{TOPIC}/json?since={load_since()}"
    req = urllib.request.Request(url, headers={"User-Agent": "elms-popup/1.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:  # keepalives arrive every ~30s
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            msg = json.loads(line)
            if msg.get("event") != "message":
                continue
            save_last_id(msg["id"])
            threading.Thread(target=show, args=(msg,), daemon=True).start()


def main() -> None:
    delay = 2
    while True:
        try:
            listen()
            delay = 2
        except Exception as e:  # network down, timeout, server hiccup...
            print(f"connection lost ({e}); retrying in {delay}s", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 60)


if __name__ == "__main__":
    main()
