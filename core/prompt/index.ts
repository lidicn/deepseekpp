export {
  buildPromptAugmentation,
  renderToolSchemas,
} from './augmentation';

export {
  FIRST_TURN_CATALOG_MARKER,
  FIRST_TURN_MEMORY_MARKER,
  stripFirstTurnOptionalSections,
  type FirstTurnStripResult,
} from './first-turn-strip';

export {
  VISIBLE_USER_PROMPT_END,
  VISIBLE_USER_PROMPT_START,
  containsInternalPromptMarker,
  extractVisibleUserPrompt,
  markVisibleUserPrompt,
  markVisibleUserPromptMetadata,
  sanitizeInternalPromptText,
} from './visibility';

export type {
  PromptAugmentationOptions,
  PromptAugmentationResult,
} from './augmentation';
