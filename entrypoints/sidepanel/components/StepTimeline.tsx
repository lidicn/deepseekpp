import { useI18n } from '../i18n';
import {
  buildStepTimeline,
  formatToolDuration,
  type ToolRunRecord,
} from '../tool-runs';

interface StepTimelineProps {
  runs: readonly ToolRunRecord[];
}

/**
 * R09：步骤时间线（纯文本，不做图形化）。
 * 把 R08 收集的工具记录按 step（工具循环轮次）分组；无 step 信息时平铺为单组。
 * 侧边栏拿不到 AGENT_STEP_STARTED/COMPLETE，因此只渲染实际派发过工具的轮次，
 * 不编造"无工具"的空步。
 */
export default function StepTimeline({ runs }: StepTimelineProps) {
  const { t } = useI18n();
  const groups = buildStepTimeline(runs);
  if (groups.length === 0) return null;

  return (
    <div className="ds-step-timeline" data-testid="step-timeline">
      {groups.map((group, groupIndex) => (
        <div
          key={groupIndex}
          className="ds-step-group"
          data-step={group.step === null ? 'flat' : group.step}
        >
          <div className="ds-step-title">
            {group.step === null
              ? t('sidepanel.stepTimeline.flatGroup')
              : t('sidepanel.stepTimeline.groupTitle', { step: group.step + 1 })}
            {'  '}
            {t('sidepanel.stepTimeline.toolSummary', { duration: formatToolDuration(group.totalMs), count: group.tools.length })}
          </div>
          {group.tools.map((tool, toolIndex) => (
            <div
              key={toolIndex}
              className="ds-step-tool"
              data-tool-name={tool.name}
              data-tool-status={
                tool.ok === undefined ? 'running' : tool.ok ? 'succeeded' : 'failed'
              }
            >
              ├─ {tool.name}  {formatToolDuration(tool.durationMs)}{' '}
              {tool.ok === undefined ? '⏳' : tool.ok ? '✅' : '❌'}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
