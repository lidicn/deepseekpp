/**
 * W34 离线 SSE 回放引擎（雏形，纯函数，零 IO、零网络）。
 *
 * 用途：把 W29 trace 里记录的 `sse.frame` 字符串序列重新变成字节流
 * （AsyncIterable<Uint8Array>），供本地「重放 + 断言 summary」复现用户报告的断流，
 * 而不必真实请求 DeepSeek。
 *
 * 边界（规格备选）：本模块只做帧 → 字节的纯回放，不接 readCompletionStreamWithCallbacks，
 * 也不重放工具执行；SSE 信封（data: / \\n\\n）是否由调用方包取决于记录格式，
 * 这里对帧内容透传，不擅自改写。
 */

/**
 * 把帧字符串序列逐个编码为 Uint8Array 异步吐出。
 * 非字符串条目跳过；空数组则迭代器为空。
 */
export async function* replaySseFrames(
  frames: readonly string[],
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const frame of frames) {
    if (typeof frame !== 'string' || frame.length === 0) continue;
    yield encoder.encode(frame);
  }
}

/**
 * 把回放迭代器聚合为单个 Uint8Array（测试/断言用）。
 * 不做换行补齐，保持与输入帧逐字节一致。
 */
export async function collectReplayedBytes(
  stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** 聚合回放结果并解码为 UTF-8 文本（断言 summary 用）。 */
export async function collectReplayedText(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  return new TextDecoder().decode(await collectReplayedBytes(stream));
}
