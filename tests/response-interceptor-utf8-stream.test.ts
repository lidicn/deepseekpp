/**
 * 审计 #4：TextDecoder stream:true 跨 chunk 重组 UTF-8 多字节字符。
 *
 * response-interceptor.ts 里 `{ stream: true }` 保证多字节字符的前 N-1 字节
 * 落在第 1 个 chunk、最后 1 字节落在第 2 个 chunk 时，最终累积文本完整。
 *
 * 变异自证：把 response-interceptor.ts 里 { stream: true } 去掉
 *          ⇒ 本用例必须红（源码检查 + TextDecoder 行为双保险）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const YAN = '验';          // 中文，UTF-8 = E9 AA 8C 三字节
const YAN_BYTES = new TextEncoder().encode(YAN);
const CHUNK_A = new Uint8Array([YAN_BYTES[0]!]);           // 不完整序列首字节
const CHUNK_B = new Uint8Array([YAN_BYTES[1]!, YAN_BYTES[2]!]);  // 剩余 + 完整前缀

function runResponseInterceptorDecode(
  chunks: Uint8Array[],
  withStream: boolean,
): string {
  // 复刻 response-interceptor.ts L295-321 的 decode 循环：
  // const decoder = new TextDecoder(undefined, { stream: true });
  // for each chunk: decoder.decode(value, { stream: true })
  // final: decoder.decode()
  const decoder = withStream
    ? new TextDecoder(undefined, { stream: true } as TextDecoderOptions)
    : new TextDecoder(undefined);
  const pieces: string[] = [];
  for (const chunk of chunks) {
    pieces.push(decoder.decode(chunk, (withStream ? { stream: true } : undefined) as unknown as TextDecodeOptions | undefined));
  }
  const finalPiece = decoder.decode();
  if (finalPiece) pieces.push(finalPiece);
  return pieces.join('');
}

describe('审计 #4：stream:true 跨 chunk 重组 UTF-8 多字节字符', () => {
  it('response-interceptor.ts 里 TextDecoder 初始化确实带 stream:true（结构守卫）', () => {
    const src = readFileSync(
      join(__dirname, '..', 'core', 'interceptor', 'response-interceptor.ts'),
      'utf-8',
    );
    // 两处都要有：L297 的构造 + L315 的每次 decode 调用
    expect(src).toMatch(/new TextDecoder\([^)]*\{[^\}]*stream:\s*true[^\}]*\}/s);
    expect(src).toMatch(/decoder\.decode\([^)]*\{[^\}]*stream:\s*true[^\}]*\}/s);
  });

  it('stream:true 时多字节字符跨两 chunk 边界 → 完整文本，无替换符', () => {
    const result = runResponseInterceptorDecode([CHUNK_A, CHUNK_B], true);
    expect(result).toBe(YAN);
    expect(result).not.toContain('\uFFFD');
  });

  it('不带 stream:true 时同样拆分 → 两个替换符（用作"改坏后的对照组"）', () => {
    // 这条不是守卫（不修也会红？不一定），只是演示 stream:true 被去掉时的行为
    const result = runResponseInterceptorDecode([CHUNK_A, CHUNK_B], false);
    // 不带 stream 时每个 chunk 独立解码不完整序列 → 两处替换符
    expect(result).toContain('\uFFFD');
    expect(result).not.toBe(YAN);
  });
});
