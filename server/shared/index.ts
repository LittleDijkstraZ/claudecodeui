// Public shared contracts consumed by Providers, Conversation Groups, and Database.
export type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  ChatBackupBundle,
  ClaudeSessionRewindMode,
  ClaudeBtwHistoryTurn,
  ConversationGroupPageOptions,
  ConversationGroupUpdate,
  ConversationGroupMemberMove,
  LLMProvider,
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
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeImageDescriptors,
  normalizeAttachmentDescriptors,
} from './image-attachments.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export { resolveClaudeCodeExecutablePath } from './claude-cli-path.js';
export {
  buildDefaultProviderCurrentActiveModel,
  createCompleteMessage,
  createNormalizedMessage,
  AppError,
  ProviderRunPreparationError,
  asyncHandler,
  createApiSuccessResponse,
  normalizeProjectPath,
  validateWorkspacePath,
} from './utils.js';

export type { ClaudeUsageBuckets, ClaudeUsageModelCounters, ClaudeUsageContext, ClaudeUsageTurn, ClaudeUsageSnapshot } from './types.js';

export { parseIncomingJsonObject } from './utils.js';

export { addClaudeUsageModels } from './utils.js';

export { resolveClaudePermissionSelection } from './utils.js';

export type { HubChatBackupSummary, HubChatBackupStatus } from './types.js';
