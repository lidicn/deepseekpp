#!/usr/bin/env node
/**
 * DPP Bridge - 最小版本 HTTP API
 * 
 * 用途：让外部脚本/curl 能调用 DPP 的 runtime 命令，加速 P3 调试。
 * 
 * 工作原理：
 * 1. 本脚本作为 native host，被 DPP 扩展通过 chrome.runtime.connectNative 连接
 * 2. 同时开一个 HTTP server（localhost:8765）
 * 3. 外部 HTTP 请求 → 转发成 native messaging 消息 → DPP 扩展 → runtime-command-registry
 * 4. 结果原路返回
 */

import { createServer } from 'node:http';

// ========== Native Messaging 协议 ==========
// Chrome native messaging: 每条消息前 4 字节是小端 uint32 长度

let buffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

function processBuffer() {
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    
    const body = buffer.slice(4, 4 + length);
    buffer = buffer.slice(4 + length);
    
    try {
      const msg = JSON.parse(body.toString('utf8'));
      handleNativeMessage(msg);
    } catch (e) {
      console.error('[dpp-bridge] parse error:', e);
    }
  }
}

function sendNativeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ========== 请求路由 ==========
// pending: 等待 DPP 响应的请求
const pending = new Map();
let nextId = 1;

function handleNativeMessage(msg) {
  // 收到来自 DPP 扩展的响应
  if (msg.type === 'response' && pending.has(msg.requestId)) {
    const { resolve, reject } = pending.get(msg.requestId);
    pending.delete(msg.requestId);
    
    if (msg.error) {
      reject(new Error(msg.error));
    } else {
      resolve(msg.result);
    }
  }
}

function sendToDpp(commandType, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    
    sendNativeMessage({
      type: 'request',
      requestId: id,
      commandType,
      payload,
    });
    
    // 30 秒超时
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout'));
      }
    }, 30000);
  });
}

// ========== HTTP Server ==========
const PORT = 8765;
const HOST = '127.0.0.1';

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    
    let payload = {};
    if (body) {
      try {
        payload = JSON.parse(body);
      } catch (e) {
        // body 不是 JSON，当作 query 参数
      }
    }
    
    // 路由：GET /memories → GET_MEMORIES
    // POST /memories/organize → PARSE_NATURAL_LANGUAGE_MEMORY
    // POST /memories/apply-draft → APPLY_MEMORY_ORGANIZE_DRAFT
    // POST /automations → CREATE_AUTOMATION
    // GET /automations → GET_AUTOMATIONS
    
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    let commandType = null;
    
    if (url.pathname === '/memories' && req.method === 'GET') {
      commandType = 'GET_MEMORIES';
    } else if (url.pathname === '/memories/organize' && req.method === 'POST') {
      commandType = 'PARSE_NATURAL_LANGUAGE_MEMORY';
    } else if (url.pathname === '/memories/apply-draft' && req.method === 'POST') {
      commandType = 'APPLY_MEMORY_ORGANIZE_DRAFT';
    } else if (url.pathname === '/memories/save' && req.method === 'POST') {
      commandType = 'SAVE_MEMORY';
      payload = payload.memory || payload;
    } else if (url.pathname === '/memories/delete' && req.method === 'POST') {
      commandType = 'DELETE_MEMORY';
    } else if (url.pathname === '/automations' && req.method === 'GET') {
      commandType = 'GET_AUTOMATIONS';
    } else if (url.pathname === '/automations' && req.method === 'POST') {
      commandType = 'CREATE_AUTOMATION';
    } else if (url.pathname === '/automations/run-now' && req.method === 'POST') {
      commandType = 'RUN_AUTOMATION_NOW';
    } else if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bridge: 'dpp-bridge', version: '0.1.0' }));
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: url.pathname, method: req.method }));
      return;
    }
    
    const result = await sendToDpp(commandType, payload);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 2026-10-21 修复：端口被占用时不再崩溃退出。
// 之前 EADDRINUSE 会直接抛未处理 error 事件让进程退出，而扩展侧会立即重连、
// 再起一个新宿主、再撞同一个占用端口 —— 形成无限重连循环
// （SW console 反复 "native port connected" -> "Native host has exited"）。
// 端口冲突只影响可选的 HTTP 调试面；native messaging 通道才是扩展真正需要的，
// 所以这里降级为「不起 HTTP 服务，但保持进程存活继续服务 native 通道」。
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[dpp-bridge] HTTP port ${PORT} already in use; continuing without the HTTP debug surface`);
    return;
  }
  console.error(`[dpp-bridge] HTTP server error: ${err && err.message}`);
});

server.listen(PORT, HOST, () => {
  console.error(`[dpp-bridge] HTTP server listening on http://${HOST}:${PORT}`);
});

// 等 DPP 扩展连接
console.error('[dpp-bridge] waiting for DPP extension to connect...');
