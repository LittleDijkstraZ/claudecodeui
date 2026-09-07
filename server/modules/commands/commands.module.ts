import * as fs from 'node:fs/promises';
import os from 'node:os';

import { providerModelsService, claudeCommandCatalog, sessionsService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { createCommandsRouter } from './commands.routes.js';

/** Commands router assembled for the authenticated server mount. */
export const commandsRoutes = createCommandsRouter({
  fileSystem: fs,
  homeDirectory: os.homedir,
  appRoot: findApplicationRoot(getModuleDirectory(import.meta.url)),
  models: providerModelsService,
  nativeCommands: {
    list: (projectPath, sessionId) => claudeCommandCatalog.list(projectPath, sessionId, sessionsService.resolveProviderSessionId(sessionId)),
  },
  runtime: {
    uptime: process.uptime,
    memoryUsage: process.memoryUsage,
    version: process.version,
    platform: process.platform,
    pid: process.pid,
  },
});
