"""Raw Chrome DevTools Protocol example — no automation framework.

Attaches to a Chrome/Brave already running with remote debugging:

    chrome --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222
    pip install websocket-client
    python examples/cdp_raw.py https://example.app

This mirrors how an agent that "rides along" in its own logged-in browser
profile would drive the page. Only the Runtime.evaluate plumbing is
CDP-specific — the shadow_reach strings are identical everywhere.
"""

import json
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

sys.path.insert(0, __file__.rsplit("/", 2)[0] + "/python")
from shadow_reach import scan_js, click_js, type_js, submit_js  # noqa: E402

DEBUG = "http://127.0.0.1:9222"
url = sys.argv[1] if len(sys.argv) > 1 else "https://example.app"


def open_tab(target_url):
    req = urllib.request.urlopen(f"{DEBUG}/json/new?{target_url}", timeout=5)
    return json.load(req)["webSocketDebuggerUrl"]


def main():
    ws = websocket.create_connection(open_tab(url), timeout=30)
    mid = [0]

    def evaluate(js):
        mid[0] += 1
        ws.send(json.dumps({
            "id": mid[0],
            "method": "Runtime.evaluate",
            "params": {"expression": js, "returnByValue": True},
        }))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid[0]:
                return msg["result"]["result"].get("value")

    time.sleep(2)  # let the SPA render

    interactables = json.loads(evaluate(scan_js()))     # pierces shadow DOM
    for el in interactables:
        print(el["selector"], "->", el["text"][:40])

    print(evaluate(click_js("text=New Post")))          # durable label selector
    time.sleep(0.5)
    print(evaluate(type_js("[contenteditable=true]", "hello mesh")))
    print(evaluate(submit_js("form")))                  # fires the app's handler
    ws.close()


if __name__ == "__main__":
    main()
