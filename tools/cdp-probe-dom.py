"""探测 deepseek 输入区 DOM 结构"""
import asyncio, json, websockets
TARGET_WS = "ws://localhost:9222/devtools/page/A1296286C470F7920302E789E484BE6A"
async def evaluate(ws, expr):
    msg = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}}
    await ws.send(json.dumps(msg))
    return json.loads(await ws.recv()).get("result", {}).get("result", {}).get("value")

async def main():
    async with websockets.connect(TARGET_WS, max_size=10*1024*1024) as ws:
        # 找 textarea 附近的所有可点击元素
        v = await evaluate(ws, """
            (() => {
              const ta = document.querySelector('textarea');
              if (!ta) return 'no textarea';
              const parent = ta.closest('div[class*="editor"], div[class*="input"], div[class*="composer"], div[class*="chat-input"]') || ta.parentElement?.parentElement?.parentElement;
              if (!parent) return 'no parent';
              const btns = parent.querySelectorAll('button, div[role="button"], div[class*="send"], div[class*="submit"], svg');
              const info = [];
              for (const b of btns) {
                const rect = b.getBoundingClientRect();
                info.push({
                  tag: b.tagName,
                  cls: (b.className?.toString?.() || '').slice(0, 80),
                  disabled: b.disabled || b.getAttribute('aria-disabled'),
                  visible: rect.bottom > 0 && rect.width > 0,
                  rect: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)}
                });
              }
              return JSON.stringify({parentCls: parent.className?.toString?.().slice(0,100), btns: info});
            })()
        """)
        print(v)

asyncio.run(main())
