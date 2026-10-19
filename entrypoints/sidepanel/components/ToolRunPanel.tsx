import {
  formatToolDuration,
  isToolRunActive,
  type ToolRunRecord,
} from '../tool-runs';

interface ToolRunPanelProps {
  runs: readonly ToolRunRecord[];
}

/**
 * R08：侧边栏工具运行面板。
 * 只展示、不交互：每条工具一个可折叠卡片，显示工具名 / 耗时 / 成败 / 摘要。
 * 运行中的条目默认展开，已结算条目折叠。
 */
export default function ToolRunPanel({ runs }: ToolRunPanelProps) {
  if (runs.length === 0) return null;

  return (
    <div className="ds-tool-run-panel" data-testid="tool-run-panel">
      {runs.map((run, index) => {
        const active = isToolRunActive(run);
        const statusIcon = active ? '⏳' : run.ok ? '✅' : '❌';
        const statusLabel = active
          ? 'running'
          : run.ok
            ? 'succeeded'
            : 'failed';
        return (
          <details
            key={`${run.startedAt}-${index}`}
            className="ds-tool-run-card"
            open={active}
            data-tool-name={run.name}
            data-tool-status={statusLabel}
          >
            <summary className="ds-tool-run-summary">
              <span className="ds-tool-run-status" aria-hidden="true">
                {statusIcon}
              </span>
              <span className="ds-tool-run-name">{run.name}</span>
              <span className="ds-tool-run-duration">
                {formatToolDuration(run.durationMs)}
              </span>
            </summary>
            {run.summary && (
              <div className="ds-tool-run-summary-text whitespace-pre-wrap">
                {run.summary}
              </div>
            )}
          </details>
        );
      })}
    </div>
  );
}
