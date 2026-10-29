import { registerVisComponent } from '../registry';
import { columnRenderer } from './column';
import { imageRenderer } from './image';
import { rowRenderer } from './row';
import { textRenderer } from './text';

/** 内置组件一次性注册（幂等：Map 覆盖写，重复调用无副作用）。 */
export function registerCoreVisComponents(): void {
  registerVisComponent(columnRenderer);
  registerVisComponent(imageRenderer);
  registerVisComponent(rowRenderer);
  registerVisComponent(textRenderer);
}

export { columnRenderer, imageRenderer, rowRenderer, textRenderer };
