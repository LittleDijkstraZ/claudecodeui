// Public shared contracts consumed by the Claude provider runtime and model catalog.
export type {
  AnyRecord,
  NormalizedMessage,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from './types.js';
export type { IProviderModels, IProviderRuntime } from './interfaces.js';
export {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors,
} from './image-attachments.js';
export { resolveClaudeCodeExecutablePath } from './claude-cli-path.js';
export {
  buildDefaultProviderCurrentActiveModel,
  createCompleteMessage,
  createNormalizedMessage,
} from './utils.js';
