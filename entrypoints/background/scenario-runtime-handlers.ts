import type { ScenarioConfig } from '../../core/types';
import type { RuntimeCommandHandler } from '../../core/messaging/runtime-command-registry';
import { defineBackgroundPayloadRuntimeCommandHandler } from './runtime-handler';

export interface ScenarioRuntimeHandlerDependencies {
  getAllScenarios(): Promise<ScenarioConfig[]>;
  saveScenario(scenario: ScenarioConfig): Promise<void>;
  addCustomScenario(label: string, template: string): Promise<ScenarioConfig>;
  deleteScenario(id: string): Promise<void>;
  refreshScenarioMenus(): Promise<void>;
}

export function createScenarioRuntimeHandlers(
  dependencies: ScenarioRuntimeHandlerDependencies,
): readonly RuntimeCommandHandler[] {
  return Object.freeze([
    defineBackgroundPayloadRuntimeCommandHandler('SCENARIOS_UPDATED', async (request) => {
      // #85: 显式枚举所有 mutation operation —— 默认拒绝，绝不执行 delete。
      // 安全纵深：decodeScenarioRuntimeRequest 已在编码层拒绝未知 operation，
      // 但 handler 自身也必须 default-deny，防止未来 handler 被绕过 decode 直接调用。
      if (request.operation === 'refresh') {
        await dependencies.refreshScenarioMenus();
        return { ok: true as const };
      }
      if (request.operation === 'get') {
        return { ok: true as const, scenarios: await dependencies.getAllScenarios() };
      }
      if (request.operation === 'save') {
        await dependencies.saveScenario(request.scenario);
      } else if (request.operation === 'add') {
        await dependencies.addCustomScenario(request.label, request.template);
      } else if (request.operation === 'delete') {
        await dependencies.deleteScenario(request.id);
      } else {
        // Default deny — 任何未知 operation 返回 ok:false，不执行任何副作用
        return { ok: false as const, error: `unknown scenario operation: ${(request as any).operation}` };
      }
      await dependencies.refreshScenarioMenus();
      return { ok: true as const, scenarios: await dependencies.getAllScenarios() };
    }),
  ]);
}
