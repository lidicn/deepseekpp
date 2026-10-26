import type { MemoryOrganizeDraft, MemoryOrganizeOperationType } from '../../../core/memory/natural-language-organize';
import { useI18n } from '../i18n';

interface MemoryOrganizeDraftPreviewProps {
  draft: MemoryOrganizeDraft;
}

const DESTRUCTIVE_OPS: MemoryOrganizeOperationType[] = ['delete', 'merge', 'clean_stale'];

export default function MemoryOrganizeDraftPreview({ draft }: MemoryOrganizeDraftPreviewProps) {
  const { t } = useI18n();
  const OPERATION_LABELS: Record<MemoryOrganizeOperationType, string> = {
    list_all: t('sidepanel.memoryOrganize.listAll'),
    delete: t('sidepanel.memoryOrganize.delete'),
    archive: t('sidepanel.memoryOrganize.archive'),
    pin: t('sidepanel.memoryOrganize.pin'),
    unpin: t('sidepanel.memoryOrganize.unpin'),
    merge: t('sidepanel.memoryOrganize.merge'),
    retitle: t('sidepanel.memoryOrganize.retitle'),
    retag: t('sidepanel.memoryOrganize.retag'),
    compress: t('sidepanel.memoryOrganize.compress'),
    clean_stale: t('sidepanel.memoryOrganize.cleanStale'),
  };
  const destructiveOps = draft.operations.filter((op) => DESTRUCTIVE_OPS.includes(op.type));
  const hasDestructiveOps = destructiveOps.length > 0;

  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="text-sm text-gray-600">{draft.summary}</div>

      {/* Issues */}
      {draft.issues.length > 0 && (
        <div className="space-y-1">
          {draft.issues.map((issue, index) => (
            <div
              key={index}
              className={`text-xs px-2 py-1 rounded ${
                issue.severity === 'error'
                  ? 'bg-red-50 text-red-700'
                  : issue.severity === 'warning'
                    ? 'bg-yellow-50 text-yellow-700'
                    : 'bg-blue-50 text-blue-700'
              }`}
            >
              {issue.message}
            </div>
          ))}
        </div>
      )}

      {/* Operations list */}
      {draft.operations.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500">{t('sidepanel.memoryOrganize.operationList', { count: draft.operations.length })}</div>
          <div className="space-y-1">
            {draft.operations.map((op, index) => (
              <div
                key={index}
                className={`text-xs px-2 py-1.5 rounded border ${
                  DESTRUCTIVE_OPS.includes(op.type)
                    ? 'border-red-200 bg-red-50'
                    : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{OPERATION_LABELS[op.type]}</span>
                  {op.memoryId !== undefined && (
                    <span className="text-gray-500">ID: {op.memoryId}</span>
                  )}
                  {op.memoryIds !== undefined && (
                    <span className="text-gray-500">IDs: {op.memoryIds.join(', ')}</span>
                  )}
                  {DESTRUCTIVE_OPS.includes(op.type) && (
                    <span className="text-red-500 text-[10px]">{t('sidepanel.memoryOrganize.destructiveBadge')}</span>
                  )}
                </div>
                {op.reason && (
                  <div className="text-gray-500 mt-0.5">{op.reason}</div>
                )}
                {op.newTitle && (
                  <div className="text-gray-500 mt-0.5">{t('sidepanel.memoryOrganize.newTitle', { value: op.newTitle })}</div>
                )}
                {op.newTags && (
                  <div className="text-gray-500 mt-0.5">{t('sidepanel.memoryOrganize.newTags', { value: op.newTags.join(', ') })}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Destructive warning */}
      {hasDestructiveOps && (
        <div className="text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded">
          {t('sidepanel.memoryOrganize.destructiveWarning', { count: destructiveOps.length })}
        </div>
      )}
    </div>
  );
}
