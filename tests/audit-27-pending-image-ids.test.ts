// 审计 #27（2026-10-24 报告 P1）——pendingImageFileIds 的「按需加载，挂载一次即消费」。
//
// 缺陷：`get refFileIds()` 只把 pending 图片 file_id 合并进返回数组、**从不清空**。
// 于是循环里第 N 轮上传的图片会被 N+1、N+2…轮的请求**反复重挂**，每多一轮就多挂
// 一次全部历史图片，请求体越滚越大。
//
// 而本文件自己的设计注释写的是「file_id 会在**下一次请求**时通过 refFileIds 传给模型」
// —— 也就是说「只挂一次」本来就是原始设计意图，实现偏离了注释。
import { describe, expect, it } from 'vitest';
import { takePendingImageFileIds } from '../core/inline-agent/pi/loop-adapter';

describe('审计 #27：pending 图片 file_id 只挂载一次', () => {
  it('首次读取：返回 base + pending，并清空 pending', () => {
    const base = ['user-file-1'];
    const pending = ['img-a', 'img-b'];
    expect(takePendingImageFileIds(base, pending)).toEqual(['user-file-1', 'img-a', 'img-b']);
    expect(pending).toEqual([]);
  });

  it('紧接的第二次读取：**不再包含**已挂载的图片（修复前会重复挂）', () => {
    const base = ['user-file-1'];
    const pending = ['img-a'];
    takePendingImageFileIds(base, pending);
    // 关键断言：模拟「下一轮请求」再读一次
    expect(takePendingImageFileIds(base, pending)).toEqual(['user-file-1']);
  });

  it('后续轮次新上传的图片仍会被挂载（负控：别把新图片也吞掉）', () => {
    const base: string[] = [];
    const pending: string[] = ['img-a'];
    expect(takePendingImageFileIds(base, pending)).toEqual(['img-a']);
    // 第二轮又上传了一张
    pending.push('img-b');
    expect(takePendingImageFileIds(base, pending)).toEqual(['img-b']);
    // 第三轮没有新图
    expect(takePendingImageFileIds(base, pending)).toEqual([]);
  });

  it('base 的 refFileIds 每轮都要在（那是用户自己附的附件，不是工具图片）', () => {
    const base = ['user-file-1', 'user-file-2'];
    const pending: string[] = [];
    expect(takePendingImageFileIds(base, pending)).toEqual(['user-file-1', 'user-file-2']);
    expect(takePendingImageFileIds(base, pending)).toEqual(['user-file-1', 'user-file-2']);
  });

  it('pending 为空时是纯读，不产生副作用', () => {
    const base = ['u1'];
    const pending: string[] = [];
    const out = takePendingImageFileIds(base, pending);
    expect(out).toEqual(['u1']);
    expect(out).not.toBe(base); // 返回新数组，调用方改它不影响入参
    expect(base).toEqual(['u1']);
  });
});
