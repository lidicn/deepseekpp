/**
 * 审计 #8：interceptHistoryResponse 清洗后 body 长度变了，不能再透传服务端旧的
 * content-length。Chrome 通常会忽略不一致的 content-length，所以判低危仅加固；
 * 但删旧值是正确做法。
 */
import { describe, expect, it } from 'vitest';
import { interceptHistoryResponse } from '../core/interceptor/history-idb-interceptor';

describe('interceptHistoryResponse · content-length', () => {
  it('清洗后返回的响应不再带旧的 content-length（由浏览器重算）', async () => {
    const body = JSON.stringify({ data: { biz_data: { chat_messages: [] } } });
    const upstream = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
    });
    const result = await interceptHistoryResponse(Promise.resolve(upstream));
    expect(result.headers.get('content-length')).toBeNull();
    // 仍然是 JSON、status 保留
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('json');
  });

  it('非 JSON 响应原样透传，不动 headers', async () => {
    const upstream = new Response('not json', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '8' },
    });
    const result = await interceptHistoryResponse(Promise.resolve(upstream));
    expect(result.headers.get('content-length')).toBe('8');
  });
});
