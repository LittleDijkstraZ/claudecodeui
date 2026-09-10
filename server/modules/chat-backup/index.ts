import { createChatBackupRouter } from './chat-backup.routes.js';
import { createChatBackupService } from './chat-backup.service.js';

/** Server entrypoint mounts native backup/restore only on the authenticated remote server. */
export const chatBackupRoutes = createChatBackupRouter(createChatBackupService());
