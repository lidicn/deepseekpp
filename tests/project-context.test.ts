import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConversationToProject,
  bindPendingProjectConversation,
  createProjectContext,
  formatProjectPromptContext,
  getProjectContextState,
  getProjectForConversation,
  getProjectPromptContextForConversation,
  refreshProjectConversation,
  removeConversationFromProject,
  setPendingProjectContext,
  updateProjectContext,
} from '../core/project';
import { PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT } from '../core/project/store';

let storage: Record<string, unknown>;

beforeEach(() => {
  storage = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          storage = { ...storage, ...values };
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session-based project context', () => {
  it('keeps one project membership per conversation', async () => {
    const first = await createProjectContext({ name: 'Alpha' });
    const second = await createProjectContext({ name: 'Beta' });

    await addConversationToProject(first.id, {
      conversationId: 'session-1',
      title: 'Draft',
      url: 'https://chat.deepseek.com/chat/s/session-1',
    });
    await addConversationToProject(second.id, {
      conversationId: 'session-1',
      title: 'Draft moved',
      url: 'https://chat.deepseek.com/chat/s/session-1',
    });

    const state = await getProjectContextState();
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]).toMatchObject({
      conversationId: 'session-1',
      projectId: second.id,
      title: 'Draft moved',
    });
    await expect(getProjectForConversation('session-1')).resolves.toMatchObject({ id: second.id });
  });

  it('binds pending project to the next conversation and clears pending state', async () => {
    const project = await createProjectContext({
      name: 'Plotforge',
      instructions: 'Keep track of story continuity.',
    });
    await setPendingProjectContext(project.id);

    const conversation = await bindPendingProjectConversation({
      conversationId: 'session-next',
      title: 'Chapter outline',
      url: 'https://chat.deepseek.com/chat/s/session-next',
    });
    const state = await getProjectContextState();
    const context = await getProjectPromptContextForConversation('session-next');

    expect(conversation?.projectId).toBe(project.id);
    expect(state.pendingProjectId).toBeNull();
    expect(formatProjectPromptContext(context!)).toContain('Project: Plotforge');
    expect(formatProjectPromptContext(context!)).toContain('Keep track of story continuity.');
  });

  it('refreshes stale project conversation titles without letting default DeepSeek titles overwrite real titles', async () => {
    const project = await createProjectContext({ name: 'Alpha' });

    await addConversationToProject(project.id, {
      conversationId: 'session-1',
      title: 'DeepSeek-探索未至之境',
      url: 'https://chat.deepseek.com/a/chat/s/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: 'Untitled conversation' })],
    });

    await refreshProjectConversation({
      conversationId: 'session-1',
      title: '真实项目标题',
      url: 'https://chat.deepseek.com/a/chat/s/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: '真实项目标题' })],
    });

    await refreshProjectConversation({
      conversationId: 'session-1',
      title: 'DeepSeek-探索未至之境',
      url: 'https://chat.deepseek.com/a/chat/s/session-1',
    });
    await expect(getProjectContextState()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ title: '真实项目标题' })],
    });
  });

  it('updates project instructions and removes conversation membership', async () => {
    const project = await createProjectContext({ name: 'Alpha', instructions: 'Old' });
    await addConversationToProject(project.id, { conversationId: 'session-1' });

    const updated = await updateProjectContext(project.id, {
      name: 'Alpha Prime',
      instructions: 'New',
    });
    await removeConversationFromProject('session-1');

    const state = await getProjectContextState();
    expect(updated.name).toBe('Alpha Prime');
    expect(state.projects[0].instructions).toBe('New');
    expect(state.conversations).toEqual([]);
  });

  it('caps each project conversation list at the newest N and evicts oldest-first', async () => {
    const project = await createProjectContext({ name: 'Alpha' });
    const total = PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT + 5;

    for (let index = 0; index < total; index++) {
      await addConversationToProject(project.id, { conversationId: `session-${index}` });
    }

    const state = await getProjectContextState();
    const remaining = state.conversations.filter((item) => item.projectId === project.id);
    expect(remaining).toHaveLength(PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT);
    // Oldest five evicted first; newest kept, and ordering preserved (newest last).
    expect(remaining.map((item) => item.conversationId)).toEqual(
      Array.from(
        { length: PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT },
        (_value, index) => `session-${index + 5}`,
      ),
    );
    expect(remaining.some((item) => item.conversationId === 'session-0')).toBe(false);
    expect(remaining[remaining.length - 1]!.conversationId).toBe(`session-${total - 1}`);
  });

  it('leaves a conversation list at or below the cap untouched', async () => {
    const project = await createProjectContext({ name: 'Alpha' });
    const count = PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT;

    for (let index = 0; index < count; index++) {
      await addConversationToProject(project.id, { conversationId: `session-${index}` });
    }

    const state = await getProjectContextState();
    expect(state.conversations).toHaveLength(count);
    expect(state.conversations.map((item) => item.conversationId)).toEqual(
      Array.from({ length: count }, (_value, index) => `session-${index}`),
    );
  });

  it('re-adding an existing conversation keeps dedupe and does not evict within the cap', async () => {
    const project = await createProjectContext({ name: 'Alpha' });
    await addConversationToProject(project.id, { conversationId: 'session-1', title: 'First' });
    await addConversationToProject(project.id, { conversationId: 'session-2' });
    await addConversationToProject(project.id, { conversationId: 'session-1', title: 'Renamed' });

    const state = await getProjectContextState();
    expect(state.conversations).toHaveLength(2);
    expect(state.conversations.map((item) => item.conversationId)).toEqual(['session-2', 'session-1']);
    expect(state.conversations[1]).toMatchObject({ conversationId: 'session-1', title: 'Renamed' });
  });

  it('applies the cap per project rather than across the whole store', async () => {
    const alpha = await createProjectContext({ name: 'Alpha' });
    const beta = await createProjectContext({ name: 'Beta' });
    await addConversationToProject(beta.id, { conversationId: 'beta-1' });

    for (let index = 0; index < PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT + 3; index++) {
      await addConversationToProject(alpha.id, { conversationId: `alpha-${index}` });
    }

    const state = await getProjectContextState();
    const alphaRemaining = state.conversations.filter((item) => item.projectId === alpha.id);
    const betaRemaining = state.conversations.filter((item) => item.projectId === beta.id);
    expect(alphaRemaining).toHaveLength(PROJECT_CONVERSATIONS_PER_PROJECT_LIMIT);
    expect(betaRemaining).toHaveLength(1);
    expect(betaRemaining[0]!.conversationId).toBe('beta-1');
  });
});
