"""CDP G1 自动化：reset → 填值 → 点发送 → 等响应 → 读 summary"""
import asyncio, json, sys, websockets

TARGET_WS = "ws://localhost:9222/devtools/page/A1296286C470F7920302E789E484BE6A"
MESSAGE = sys.argv[1] if len(sys.argv) > 1 else "帮我记住：今天测试工具调用是否正常"
WAIT_SEC = int(sys.argv[2]) if len(sys.argv) > 2 else 40

async def evaluate(ws, expr):
    msg = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}}
    await ws.send(json.dumps(msg))
    return json.loads(await ws.recv()).get("result", {}).get("result", {}).get("value")

async def main():
    async with websockets.connect(TARGET_WS, max_size=10*1024*1024) as ws:
        # 1. reset
        await evaluate(ws, "window.__DPP_DEBUG__?.reset()")
        print("[reset done]")

        # 2. 填值到 textarea（用 React 兼容方式）
        v = await evaluate(ws, f"""
            (() => {{
              const ta = document.querySelector('textarea');
              if (!ta) return 'no textarea';
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              setter.call(ta, {json.dumps(MESSAGE)});
              ta.dispatchEvent(new Event('input', {{bubbles: true}}));
              ta.dispatchEvent(new Event('change', {{bubbles: true}}));
              ta.focus();
              return 'typed, len=' + ta.value.length;
            }})()
        """)
        print(f"[type] {v}")

        # 3. 等 1 秒让 React 状态更新
        await asyncio.sleep(1)

        # 4. 找发送按钮并点击
        v = await evaluate(ws, """
            (() => {
              // 发送按钮 = primary filled circle
              const btns = document.querySelectorAll('div.ds-button--primary.ds-button--filled.ds-button--circle');
              for (const b of btns) {
                const rect = b.getBoundingClientRect();
                if (rect.bottom > 0 && rect.width > 0) {
                  b.click();
                  return 'clicked send button at ' + JSON.stringify({x: Math.round(rect.x), y: Math.round(rect.y)});
                }
              }
              // fallback: 找所有 primary 按钮
              const all = document.querySelectorAll('div.ds-button--primary');
              for (const b of all) {
                const rect = b.getBoundingClientRect();
                if (rect.bottom > 0 && rect.width > 0 && rect.y > 1000) {
                  b.click();
                  return 'clicked fallback button at ' + JSON.stringify({x: Math.round(rect.x), y: Math.round(rect.y)});
                }
              }
              return 'no send button found';
            })()
        """)
        print(f"[send] {v}")

        # 5. 等响应
        print(f"[waiting {WAIT_SEC}s for response...]")
        await asyncio.sleep(WAIT_SEC)

        # 6. 读 summary
        v = await evaluate(ws, "window.__DPP_DEBUG__ ? JSON.stringify(window.__DPP_DEBUG__.summary()) : 'no debug'")
        print(f"[summary] {v}")

if __name__ == "__main__":
    asyncio.run(main())
