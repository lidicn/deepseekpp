#!/usr/bin/env python3
"""Reload an unpacked Chrome MV3 extension via CDP.

Connects to a Chrome started with --remote-debugging-port=9222, finds the
service worker of a target extension, and evaluates chrome.runtime.reload()
inside it. The extension reloads from its on-disk directory (dist/chrome-mv3
when loaded as an unpacked extension).

Usage:
    python tools/reload-extension.py                        # reload dpp (jjjhcjjegfplcfncohmfhbdhcalmijnc)
    python tools/reload-extension.py <extension-id>         # reload a specific extension
"""
import asyncio
import json
import sys
import urllib.request

import websockets

CDP_HTTP = "http://localhost:9222"
DEFAULT_EXT_ID = "jjjhcjjegfplcfncohmfhbdhcalmijnc"


def list_targets() -> list[dict]:
    with urllib.request.urlopen(f"{CDP_HTTP}/json", timeout=3) as r:
        return json.loads(r.read())


def find_service_worker_ws(ext_id: str) -> str | None:
    for t in list_targets():
        if t.get("type") == "service_worker" and ext_id in t.get("url", ""):
            return t["webSocketDebuggerUrl"]
    return None


async def reload(ext_id: str) -> None:
    ws_url = find_service_worker_ws(ext_id)
    if not ws_url:
        raise SystemExit(
            f"service worker for extension {ext_id} not found.\n"
            f"Make sure Chrome is running with --remote-debugging-port=9222 "
            f"and the extension is loaded."
        )
    print(f"[reload] connecting to {ws_url}")
    async with websockets.connect(ws_url) as ws:
        # Enable Runtime domain.
        await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
        await ws.recv()
        # Evaluate chrome.runtime.reload(). This kills the service worker;
        # Chrome immediately restarts it from disk (the new build).
        await ws.send(
            json.dumps(
                {
                    "id": 2,
                    "method": "Runtime.evaluate",
                    "params": {"expression": "chrome.runtime.reload()"},
                }
            )
        )
        # The reload call returns immediately; the WS will then drop.
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=3)
                data = json.loads(raw)
                if data.get("id") == 2:
                    print(f"[reload] response: {data.get('result', data)}")
                    break
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
    print(f"[reload] extension {ext_id} reload triggered (new build loaded from disk)")


def main() -> None:
    ext_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_EXT_ID
    asyncio.run(reload(ext_id))


if __name__ == "__main__":
    main()
