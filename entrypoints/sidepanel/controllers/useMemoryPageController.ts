import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocaleMessageKey, MessageParams } from '../../../core/i18n';
import type { Memory, NewMemory } from '../../../core/types';
import type { MemoryOrganizeDraft } from '../../../core/memory/natural-language-organize';
import { createRequestGenerationFence } from '../async-state';
import { getRuntimeErrorMessage } from '../runtime-response';
import { decodeMemoryList, libraryController } from './library-controller';

type Translator = (key: LocaleMessageKey, params?: MessageParams) => string;
type Confirm = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}) => Promise<boolean>;
type Feedback = {
  clear(): void;
  error(message: string): void;
};

export function useMemoryPageController(t: Translator, confirm: Confirm, feedback: Feedback) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [showOrganizePanel, setShowOrganizePanel] = useState(false);
  const [organizeInput, setOrganizeInput] = useState('');
  const [organizeDraft, setOrganizeDraft] = useState<MemoryOrganizeDraft | null>(null);
  const [organizeLoading, setOrganizeLoading] = useState(false);
  const requestFence = useRef(createRequestGenerationFence());
  const translatorRef = useRef(t);
  const feedbackRef = useRef(feedback);
  translatorRef.current = t;
  feedbackRef.current = feedback;

  const showOperationError = useCallback((error: unknown) => {
    feedbackRef.current.error(translatorRef.current('sidepanel.memoryPage.operationFailed', {
      error: getRuntimeErrorMessage(error),
    }));
  }, []);

  const load = useCallback(async () => {
    const generation = requestFence.current.begin();
    try {
      const next = await libraryController.getMemories();
      if (!requestFence.current.isCurrent(generation)) return;
      setMemories(next.filter((memory) => memory.scope !== 'project'));
      setLoadFailed(false);
    } catch (error) {
      if (!requestFence.current.isCurrent(generation)) return;
      setLoadFailed(true);
      showOperationError(error);
    } finally {
      if (requestFence.current.isCurrent(generation)) setLoading(false);
    }
  }, [showOperationError]);

  useEffect(() => {
    void load();
    const applyStateUpdate = (message: { type?: string; memories?: unknown }) => {
      if (message.type !== 'STATE_UPDATED') return;
      requestFence.current.invalidate();
      setLoading(false);
      try {
        const next = decodeMemoryList(message.memories, 'memoryUpdate');
        setMemories(next.filter((memory) => memory.scope !== 'project'));
        setLoadFailed(false);
      } catch (error) {
        setLoadFailed(true);
        showOperationError(error);
      }
    };
    const reloadWhenVisible = () => {
      if (!document.hidden) void load();
    };
    chrome.runtime.onMessage.addListener(applyStateUpdate);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    window.addEventListener('focus', reloadWhenVisible);
    return () => {
      requestFence.current.invalidate();
      chrome.runtime.onMessage.removeListener(applyStateUpdate);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
      window.removeEventListener('focus', reloadWhenVisible);
    };
  }, [load]);

  const remove = useCallback(async (id: number) => {
    const approved = await confirm({
      title: t('sidepanel.memoryPage.deleteConfirm'),
      message: t('sidepanel.memoryPage.deleteConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!approved) return;
    try {
      feedback.clear();
      await libraryController.deleteMemory(id);
      await load();
    } catch (error) {
      showOperationError(error);
    }
  }, [confirm, feedback, load, showOperationError, t]);

  const save = useCallback(async (memory: NewMemory) => {
    try {
      feedback.clear();
      if (editingMemory?.id) {
        await libraryController.updateMemory({
          ...editingMemory,
          ...memory,
          updatedAt: Date.now(),
        });
      } else {
        await libraryController.saveMemory(memory);
      }
      setShowForm(false);
      setEditingMemory(null);
      await load();
    } catch (error) {
      showOperationError(error);
    }
  }, [editingMemory, feedback, load, showOperationError]);

  const togglePin = useCallback(async (memory: Memory) => {
    try {
      feedback.clear();
      await libraryController.updateMemory({ ...memory, pinned: !memory.pinned });
      await load();
    } catch (error) {
      showOperationError(error);
    }
  }, [feedback, load, showOperationError]);

  // visibleMemoryIds：用户在记忆页当前筛选下看到的、按显示顺序排列的记忆 ID。
  // 必须由调用方（MemoryPage）传入 filtered 的 id 序列 —— 否则后端按全量存储
  // 顺序解释「第 N 条」，与用户认知不同基准，会删错记忆（越权删除）。
  const generateOrganizeDraft = useCallback(async (visibleMemoryIds?: number[]) => {
    if (!organizeInput.trim()) return;
    try {
      feedback.clear();
      setOrganizeLoading(true);
      const result = await libraryController.organizeMemoriesFromNaturalLanguage(
        organizeInput.trim(),
        visibleMemoryIds,
      );
      if (result.ok) {
        setOrganizeDraft(result.draft);
      } else {
        showOperationError(result.error);
      }
    } catch (error) {
      showOperationError(error);
    } finally {
      setOrganizeLoading(false);
    }
  }, [feedback, organizeInput, showOperationError]);

  const applyOrganizeDraft = useCallback(async (destructiveConfirmed: boolean) => {
    if (!organizeDraft) return;
    try {
      feedback.clear();
      setOrganizeLoading(true);
      const result = await libraryController.applyMemoryOrganizeDraft(organizeDraft, true, destructiveConfirmed);
      if (result.ok) {
        const successCount = result.outcomes.filter((o) => o.ok).length;
        const failCount = result.outcomes.filter((o) => !o.ok).length;
        if (failCount === 0) {
          feedback.clear();
        } else {
          showOperationError(t('sidepanel.memoryPage.organizeResult', { success: successCount, fail: failCount }));
        }
        setOrganizeDraft(null);
        setOrganizeInput('');
        await load();
      } else {
        showOperationError(result.error);
      }
    } catch (error) {
      showOperationError(error);
    } finally {
      setOrganizeLoading(false);
    }
  }, [feedback, load, organizeDraft, showOperationError]);

  const cancelOrganize = useCallback(() => {
    setOrganizeDraft(null);
    setOrganizeInput('');
    setShowOrganizePanel(false);
  }, []);

  return {
    memories,
    loading,
    loadFailed,
    showForm,
    editingMemory,
    showOrganizePanel,
    organizeInput,
    organizeDraft,
    organizeLoading,
    toggleCreateForm() {
      setEditingMemory(null);
      setShowForm((visible) => !visible);
    },
    edit(memory: Memory) {
      setEditingMemory(memory);
      setShowForm(true);
    },
    cancelEdit() {
      setShowForm(false);
      setEditingMemory(null);
    },
    remove,
    save,
    togglePin,
    setOrganizeInput,
    toggleOrganizePanel() {
      setShowOrganizePanel((visible) => !visible);
    },
    generateOrganizeDraft,
    applyOrganizeDraft,
    cancelOrganize,
  };
}
