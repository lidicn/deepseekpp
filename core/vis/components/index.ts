import { registerVisComponent } from '../registry';
import { columnRenderer } from './column';
import { imageRenderer } from './image';
import { textRenderer } from './text';

/** 内置组件一次性注册（幂等：Map 覆盖写，重复调用无副作用）。 */
export function registerCoreVisComponents(): void {
  registerVisComponent(columnRenderer);
  registerVisComponent(imageRenderer);
  registerVisComponent(textRenderer);
}

export { columnRenderer, imageRenderer, textRenderer };
