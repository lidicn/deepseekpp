import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import StepTimeline from '../entrypoints/sidepanel/components/StepTimeline';
import ToolRunPanel from '../entrypoints/sidepanel/components/ToolRunPanel';
import {
  buildStepTimeline,
  formatToolDuration,
  reduceToolRuns,
  type ToolRunRecord,
} from '../entrypoints/sidepanel/tool-runs';

describe('R08 reduceToolRuns event folding', () => {
  it('appends an active record on start and settles it on matching end', () => {
    let runs: ToolRunRecord[] = [];
    runs = reduceToolRuns(runs, { phase: 'start', name: 'shell_exec', startedAt: 1000 });
    expect(runs).toHaveLength(1);
    expect(runs[0].name).toBe('shell_exec');
    expect(runs[0].ok).toBeUndefined();

    runs = reduceToolRuns(runs, {
      phase: 'end',
      name: 'shell_exec',
      startedAt: 1000,
      ok: true,
      durationMs: 1200,
      summary: 'done'.repeat(1),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, durationMs: 1200, summary: 'done' });
  });

  it('marks failure when end carries ok=false and keeps the message', () => {
    let runs: ToolRunRecord[] = [];
    runs = reduceToolRuns(runs, { phase: 'start', name: 'local_file_read', startedAt: 5 });
    runs = reduceToolRuns(runs, {
      phase: 'end',
      name: 'local_file_read',
      startedAt: 5,
      ok: false,
      durationMs: 80,
      summary: 'file not found',
    });
    expect(runs[0]).toMatchObject({ ok: false, summary: 'file not found' });
  });

  it('registers a late end without a matching start instead of dropping it', () => {
    const runs = reduceToolRuns([], {
      phase: 'end',
      name: 'sample_tool',
      startedAt: 42,
      ok: false,
      durationMs: 30,
      summary: 'resume settlement',
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: 'sample_tool', ok: false });
  });

  it('formats sub-second and multi-second durations', () => {
    expect(formatToolDuration(340)).toBe('340ms');
    expect(formatToolDuration(1200)).toBe('1.2s');
    expect(formatToolDuration(undefined)).toBe('…');
  });

  it('buildStepTimeline groups by step and sums settled durations', () => {
    const runs: ToolRunRecord[] = [
      { name: 'shell_exec', step: 0, startedAt: 1, ok: true, durationMs: 1100 },
      { name: 'local_file_read', step: 1, startedAt: 2, ok: true, durationMs: 200 },
      { name: 'local_file_write', step: 1, startedAt: 3, ok: false, durationMs: 300 },
    ];
    const groups = buildStepTimeline(runs);
    expect(groups).toHaveLength(2);
    expect(groups[0].step).toBe(0);
    expect(groups[0].tools).toHaveLength(1);
    expect(groups[0].totalMs).toBe(1100);
    expect(groups[1].step).toBe(1);
    expect(groups[1].tools).toHaveLength(2);
    expect(groups[1].totalMs).toBe(500);
  });

  it('buildStepTimeline flattens records without step into one null group', () => {
    const groups = buildStepTimeline([
      { name: 'sample_tool', startedAt: 1, ok: true, durationMs: 50 },
      { name: 'shell_exec', startedAt: 2, ok: true, durationMs: 70 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].step).toBeNull();
    expect(groups[0].tools).toHaveLength(2);
  });
});

describe('R08 ToolRunPanel renders the tool name', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  it('renders the settled tool name, success mark and duration', () => {
    const runs: ToolRunRecord[] = [
      { name: 'shell_exec', startedAt: 1, ok: true, durationMs: 1200, summary: 'ok' },
    ];
    act(() => {
      root?.render(React.createElement(ToolRunPanel, { runs }));
    });
    const card = container.querySelector('[data-tool-name="shell_exec"]');
    expect(card).not.toBeNull();
    expect(container.textContent).toContain('shell_exec');
    expect(container.textContent).toContain('1.2s');
    expect(card?.getAttribute('data-tool-status')).toBe('succeeded');
  });

  it('shows an active (running) record expanded with running status', () => {
    const runs: ToolRunRecord[] = [{ name: 'python_exec', startedAt: 9 }];
    act(() => {
      root?.render(React.createElement(ToolRunPanel, { runs }));
    });
    const card = container.querySelector('[data-tool-name="python_exec"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-tool-status')).toBe('running');
    expect((card as HTMLDetailsElement).open).toBe(true);
  });

  it('renders nothing when there are no runs', () => {
    act(() => {
      root?.render(React.createElement(ToolRunPanel, { runs: [] }));
    });
    expect(container.querySelector('[data-testid="tool-run-panel"]')).toBeNull();
  });

  it('R09 StepTimeline renders grouped step title and tool name', () => {
    const runs: ToolRunRecord[] = [
      { name: 'shell_exec', step: 0, startedAt: 1, ok: true, durationMs: 1100 },
      { name: 'local_file_read', step: 1, startedAt: 2, ok: true, durationMs: 200 },
    ];
    act(() => {
      root?.render(React.createElement(StepTimeline, { runs }));
    });
    expect(container.querySelector('[data-testid="step-timeline"]')).not.toBeNull();
    expect(container.textContent).toContain('step 1');
    expect(container.textContent).toContain('step 2');
    expect(container.textContent).toContain('shell_exec');
    expect(container.textContent).toContain('local_file_read');
  });

  it('R09 StepTimeline flattens to 工具序列 when step is absent', () => {
    const runs: ToolRunRecord[] = [
      { name: 'sample_tool', startedAt: 1, ok: true, durationMs: 50 },
    ];
    act(() => {
      root?.render(React.createElement(StepTimeline, { runs }));
    });
    expect(container.textContent).toContain('工具序列');
    expect(container.querySelector('[data-step="flat"]')).not.toBeNull();
  });
});
