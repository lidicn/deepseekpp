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
import os
import sys
import urllib.request

import websockets

CDP_HTTP = "http://localhost:9222"
DEFAULT_EXT_ID = "jjjhcjjegfplcfncohmfhbdhcalmijnc"


def list_targets() -> list[dict]:
    with urllib.request.urlopen(f"{CDP_HTTP}/json", timeout=3) as r:
        return json.loads(r.read())



def discover_ext_id(cdp_port: int = 9222) -> str | None:
    """C4′：从 CDP /json/list 自动发现扩展 ID。

    为什么必须发现而不是硬编码：manifest 没有 key ⇒ 未打包扩展的 ID 由**加载目录**派生，
    换个目录 ID 就变（同一份源码在 Chrome/Edge/豆包 下是三个不同 ID）。
    也**不**用"路径 SHA-256 → a–p"去推导：实测推不出当前生效的 ID，猜错会静默操作错扩展。
    """
    import json
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/list", timeout=3) as response:
            targets = json.load(response)
    except Exception:
        return None

    def id_from_url(url: object) -> str | None:
        if not isinstance(url, str) or not url.startswith("chrome-extension://"):
            return None
        candidate = url[len("chrome-extension://"):].split("/")[0]
        if len(candidate) == 32 and all("a" <= ch <= "p" for ch in candidate):
            return candidate
        return None

    # service_worker 一定属于运行中的扩展，比页面更可靠
    for target in targets:
        if isinstance(target, dict) and target.get("type") == "service_worker":
            found = id_from_url(target.get("url"))
            if found:
                return found
    for target in targets:
        if isinstance(target, dict):
            found = id_from_url(target.get("url"))
            if found:
                return found
    return None


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
    ext_id = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DPP_EXT_ID")
    if not ext_id:
        ext_id = discover_ext_id()
        if ext_id:
            print(f"[reload] 自动发现扩展 id: {ext_id}")
    if not ext_id:
        print(
            "[reload] 无法确定扩展 ID：请带 --remote-debugging-port=9222 启动浏览器，"
            "或设 DPP_EXT_ID，或把它作为第一个参数传入。",
            file=sys.stderr,
        )
        sys.exit(2)
    asyncio.run(reload(ext_id))


if __name__ == "__main__":
    main()
