/**
 * 组件目录：**可注册的** spec 表（不再写死 Record<字面量联合>）。
 *
 * 为什么要开放：S2 的目标是「加一个组件 = 新增 components/*.ts + 一行注册」，
 * 不需要改 catalog、更不需要改 render。spec 由组件自身声明，注册时登记。
 */
export interface ComponentSpec {
  /** 组件类型名（渲染时判别用）。 */
  type: string;
  /** 是否允许 children。 */
  allowsChildren: boolean;
  /** 子节点上限（不允许子节点时无意义）。 */
  maxChildren: number;
}

const specs = new Map<string, ComponentSpec>();

export function registerComponentSpec(spec: ComponentSpec): void {
  specs.set(spec.type, spec);
}

export function unregisterComponentSpec(type: string): void {
  specs.delete(type);
}

export function getComponentSpec(type: string): ComponentSpec | undefined {
  return specs.get(type);
}

export function isKnownComponentType(value: unknown): value is string {
  return typeof value === 'string' && specs.has(value);
}

export function listComponentSpecs(): ComponentSpec[] {
  return [...specs.values()];
}

export function resetComponentSpecsForTests(): void {
  specs.clear();
}
