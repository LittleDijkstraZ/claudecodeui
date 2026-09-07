import { stat } from 'node:fs/promises';

import { conversationGroupsDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/index.js';
import type { ConversationGroupPageOptions, LLMProvider } from '@/shared/index.js';

/** Cross-project member row returned by the group service, including archived conversations. */
type GroupedConversation = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  lastActivity: string | null;
  isArchived: boolean;
};

type GroupServiceDependencies = {
  groups: typeof conversationGroupsDb;
  sessions: typeof sessionsService;
  getSession: typeof sessionsDb.getSessionById;
  getProject: typeof projectsDb.getProjectPath;
  validatePath: typeof validateWorkspacePath;
  isDirectory: (projectPath: string) => Promise<boolean>;
};

/** Used by group routes and tests to coordinate ownership, member metadata, and atomic empty-session creation. */
export function createConversationGroupsService(overrides: Partial<GroupServiceDependencies> = {}) {
  const dependencies: GroupServiceDependencies = {
    groups: conversationGroupsDb,
    sessions: sessionsService,
    getSession: sessionId => sessionsDb.getSessionById(sessionId),
    getProject: projectPath => projectsDb.getProjectPath(projectPath),
    validatePath: validateWorkspacePath,
    isDirectory: async projectPath => {
      try { return (await stat(projectPath)).isDirectory(); } catch { return false; }
    },
    ...overrides,
  };

  function requireGroup(userId: number, id: string) {
    const group = dependencies.groups.getGroup(userId, id);
    if (!group) throw new AppError('Conversation group was not found.', { code: 'GROUP_NOT_FOUND', statusCode: 404 });
    return group;
  }

  return {
    list: (userId: number) => dependencies.groups.list(userId),
    create: (userId: number, name: string) => dependencies.groups.create(userId, name),

    rename(userId: number, id: string, name: string) {
      return dependencies.groups.atomic(() => {
        requireGroup(userId, id);
        dependencies.groups.rename(userId, id, name);
        return requireGroup(userId, id);
      });
    },

    delete(userId: number, id: string) {
      dependencies.groups.atomic(() => {
        requireGroup(userId, id);
        dependencies.groups.delete(userId, id);
      });
    },

    setMembership(userId: number, sessionId: string, groupId: string | null) {
      dependencies.groups.atomic(() => {
        if (groupId !== null) requireGroup(userId, groupId);
        if (!dependencies.getSession(sessionId)) {
          throw new AppError('Conversation was not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
        }
        dependencies.groups.setMembership(userId, sessionId, groupId);
      });
    },

    members(userId: number, id: string, options: ConversationGroupPageOptions) {
      return dependencies.groups.atomic(() => {
        requireGroup(userId, id);
        const page = dependencies.groups.memberPage(userId, id, options);
        const conversations: GroupedConversation[] = page.sessionIds.map(sessionId => {
          const session = dependencies.sessions.getSessionDetailsById(sessionId);
          return {
            sessionId: session.sessionId,
            provider: session.provider,
            projectId: session.project?.projectId ?? null,
            projectPath: session.project?.path ?? null,
            projectDisplayName: session.project?.displayName ?? 'Unknown Project',
            sessionTitle: session.summary || 'Untitled Session',
            lastActivity: session.lastActivity,
            isArchived: session.isArchived,
          };
        });
        return { conversations, total: page.total, hasMore: options.offset + conversations.length < page.total };
      });
    },

    async createSession(userId: number, id: string, provider: LLMProvider, requestedPath: string) {
      requireGroup(userId, id);
      const validation = await dependencies.validatePath(requestedPath);
      if (!validation.valid || !validation.resolvedPath) {
        throw new AppError('Invalid project path.', { code: 'INVALID_PROJECT_PATH', statusCode: 400 });
      }
      const projectPath = normalizeProjectPath(validation.resolvedPath);
      const project = dependencies.getProject(projectPath);
      if (!project || !(await dependencies.isDirectory(projectPath))) {
        throw new AppError('Select an existing project directory.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      }
      // No await can occur within this transaction: group deletion during path
      // validation must not leave an ungrouped, partially-created conversation.
      return dependencies.groups.atomic(() => {
        requireGroup(userId, id);
        const session = dependencies.sessions.createAppSession(provider, projectPath);
        dependencies.groups.setMembership(userId, session.sessionId, id);
        return { ...session, projectId: project.project_id };
      });
    },
  };
}

/** Used by the group router for the current installation's database and provider session gateway. */
export const conversationGroupsService = createConversationGroupsService();
