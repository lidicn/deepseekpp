import { useState } from 'react';
import type { MemoryType } from '../../../core/types';
import MemoryCard from '../components/MemoryCard';
import MemoryForm from '../components/MemoryForm';
import MemoryOrganizeDraftPreview from '../components/MemoryOrganizeDraftPreview';
import PageIntro from '../components/PageIntro';
import { SegmentedControl, SkeletonList, useBanner, useConfirm } from '../components/settings/primitives';
import { MEMORY_TYPE_CONFIG } from '../constants';
import { useMemoryPageController } from '../controllers/useMemoryPageController';
import { useI18n } from '../i18n';

export default function MemoryPage() {
  const { t } = useI18n();
  const [filter, setFilter] = useState<MemoryType | 'all'>('all');
  const banner = useBanner();
  const { confirm, node: confirmNode } = useConfirm();
  const {
    memories,
    loading,
    loadFailed,
    showForm,
    editingMemory,
    showOrganizePanel,
    organizeInput,
    organizeDraft,
    organizeLoading,
    toggleCreateForm,
    edit,
    cancelEdit,
    remove,
    save,
    togglePin,
    setOrganizeInput,
    toggleOrganizePanel,
    generateOrganizeDraft,
    applyOrganizeDraft,
    cancelOrganize,
  } = useMemoryPageController(t, confirm, {
    clear: banner.clear,
    error: (message) => banner.show('error', message),
  });

  const filtered = filter === 'all' ? memories : memories.filter((m) => m.type === filter);
  const filterTypes = [
    { key: 'all' as const, label: t('common.all') },
    ...MEMORY_TYPE_CONFIG.map((typeConfig) => ({
      key: typeConfig.key,
      label: t(typeConfig.labelKey),
    })),
  ];

  const handleApplyDraft = async () => {
    if (!organizeDraft) return;
    const hasDestructiveOps = organizeDraft.operations.some((op) =>
      ['delete', 'merge', 'clean_stale'].includes(op.type),
    );
    if (hasDestructiveOps) {
      const approved = await confirm({
        title: '确认执行破坏性操作',
        message: '检测到破坏性操作（删除/合并/清理），执行后不可恢复。确认继续？',
        confirmLabel: '确认执行',
        cancelLabel: '取消',
      });
      if (!approved) return;
      await applyOrganizeDraft(true);
    } else {
      await applyOrganizeDraft(false);
    }
  };

  return (
    <div className="p-4 space-y-3">
      <PageIntro
        title={t('sidepanel.memoryPage.title')}
        description={t('sidepanel.memoryPage.description')}
        meta={t('sidepanel.memoryPage.count', { count: memories.length })}
      />

      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          options={filterTypes}
          value={filter}
          onChange={(key) => setFilter(key)}
          ariaLabel={t('sidepanel.memoryPage.title')}
          size="sm"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={toggleOrganizePanel}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-lg transition-all duration-150 hover:bg-gray-200"
          >
            ✨ 自然语言整理
          </button>
          <button
            onClick={toggleCreateForm}
            className="ds-btn-primary px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-all duration-150 flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {t('common.add')}
          </button>
        </div>
      </div>

      {confirmNode}
      {banner.node}

      {/* 自然语言整理面板 */}
      {showOrganizePanel && (
        <div className="animate-slide-down border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
          {!organizeDraft ? (
            <>
              <textarea
                value={organizeInput}
                onChange={(e) => setOrganizeInput(e.target.value)}
                placeholder="描述你想怎么整理记忆，如：给偏好类记忆打上 preference tag"
                className="w-full h-20 px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={generateOrganizeDraft}
                  disabled={!organizeInput.trim() || organizeLoading}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg transition-all duration-150 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {organizeLoading ? '生成中...' : '生成整理方案'}
                </button>
                <button
                  onClick={cancelOrganize}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-200 rounded-lg transition-all duration-150 hover:bg-gray-300"
                >
                  取消
                </button>
              </div>
            </>
          ) : (
            <>
              <MemoryOrganizeDraftPreview draft={organizeDraft} />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleApplyDraft}
                  disabled={organizeLoading || organizeDraft.operations.length === 0}
                  className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg transition-all duration-150 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {organizeLoading ? '执行中...' : '确认执行'}
                </button>
                <button
                  onClick={cancelOrganize}
                  className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-200 rounded-lg transition-all duration-150 hover:bg-gray-300"
                >
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {showForm && (
        <div className="animate-slide-down">
          <MemoryForm
            initial={editingMemory}
            onSave={save}
            onCancel={cancelEdit}
          />
        </div>
      )}

      {loading ? (
        <SkeletonList rows={3} />
      ) : !loadFailed && filtered.length === 0 ? (
        <div className="ds-empty-state">
          <div className="ds-empty-state-icon">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          </div>
          <div className="ds-empty-state-title">
            {memories.length === 0 ? t('sidepanel.memoryPage.emptyAll') : t('sidepanel.memoryPage.emptyFiltered')}
          </div>
          {memories.length === 0 && (
            <div className="ds-empty-state-description">
              {t('sidepanel.memoryPage.emptyHelp')}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => (
            <MemoryCard
              key={m.id}
              memory={m}
              onDelete={() => remove(m.id!)}
              onEdit={() => edit(m)}
              onTogglePin={() => togglePin(m)}
            />
          ))}
        </div>
      )}

    </div>
  );
}
