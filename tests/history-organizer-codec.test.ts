import { describe, expect, it } from 'vitest';
import {
  createEmptyHistoryOrganizerState,
  decodeHistoryOrganizerState,
  normalizeHistoryTags,
} from '../core/history-organizer/codec';

// T31: history-organizer codec 编解码往返、损坏输入拒绝、标签规范化。

describe('createEmptyHistoryOrganizerState', () => {
  it('starts at schema version 1 with an empty tag map', () => {
    const empty = createEmptyHistoryOrganizerState();
    expect(empty.schemaVersion).toBe(1);
    expect(empty.tagsBySessionId).toEqual({});
  });
});

describe('decodeHistoryOrganizerState · round-trip and defaults', () => {
  it('parses tags and fills a missing schemaVersion with 1', () => {
    const out = decodeHistoryOrganizerState({ tagsBySessionId: { s1: ['work', 'urgent'] } });
    expect(out.schemaVersion).toBe(1);
    expect(out.tagsBySessionId.s1).toEqual(['work', 'urgent']);
  });

  it('normalizes tags through normalizeHistoryTags on decode', () => {
    const out = decodeHistoryOrganizerState({ tagsBySessionId: { s1: ['a, b', 'b', ''] } });
    expect(out.tagsBySessionId.s1).toEqual(['a', 'b']);
  });
});

describe('decodeHistoryOrganizerState · corrupted input', () => {
  it('rejects non-object roots', () => {
    expect(() => decodeHistoryOrganizerState([1, 2])).toThrow(/must be an object/);
    expect(() => decodeHistoryOrganizerState('nope')).toThrow(/must be an object/);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => decodeHistoryOrganizerState({ schemaVersion: 99, tagsBySessionId: {} }))
      .toThrow(/schemaVersion is not supported/);
  });

  it('rejects a non-object tagsBySessionId and an empty session id', () => {
    expect(() => decodeHistoryOrganizerState({ tagsBySessionId: 'x' })).toThrow(/must be an object/);
    expect(() => decodeHistoryOrganizerState({ tagsBySessionId: { '': ['x'] } }))
      .toThrow(/empty session id/);
  });

  it('rejects a non-string tag entry', () => {
    expect(() => decodeHistoryOrganizerState({ tagsBySessionId: { s1: [123] } }))
      .toThrow(/must be a string/);
  });
});

describe('normalizeHistoryTags', () => {
  it('splits on commas, trims, drops blanks, dedupes and caps at 12', () => {
    expect(normalizeHistoryTags(['  work ', 'work', '', 'a,b'])).toEqual(['work', 'a', 'b']);
    const thirteen = Array.from({ length: 13 }, (_, i) => `t${i}`);
    expect(normalizeHistoryTags(thirteen)).toHaveLength(12);
  });
});
