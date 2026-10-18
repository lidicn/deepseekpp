"""只读模式：读当前 summary 不发消息"""
import asyncio, json, websockets
TARGET_WS = "ws://localhost:9222/devtools/page/A1296286C470F7920302E789E484BE6A"
async def evaluate(ws, expr):
    msg = {"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True}}
    await ws.send(json.dumps(msg))
    return json.loads(await ws.recv()).get("result", {}).get("result", {}).get("value")

async def main():
    async with websockets.connect(TARGET_WS, max_size=10*1024*1024) as ws:
        v = await evaluate(ws, "window.__DPP_DEBUG__ ? JSON.stringify(window.__DPP_DEBUG__.summary()) : 'no debug'")
        print(v)

asyncio.run(main())
