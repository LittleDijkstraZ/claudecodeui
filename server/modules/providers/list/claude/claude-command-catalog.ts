import path from 'node:path';

const DOCUMENTED_COMMANDS = [
  { name: 'compact', description: 'Summarize earlier context in this conversation; optional focus instructions. Prior messages are required.', argumentHint: '[focus instructions]' },
  { name: 'context', description: 'Show the native Claude context usage for this conversation.', argumentHint: '' },
  { name: 'usage', description: 'Show the usage information available to this remote Claude process.', argumentHint: '' },
];
const UNAVAILABLE_COMMANDS: Record<string, string> = {
  clear: 'Use New Conversation to start fresh. /clear changes the native session identity and is not integrated with Chat.',
  reset: 'Use New Conversation to start fresh. Native context reset is not integrated with Chat.',
  resume: 'Choose the conversation in the sidebar instead of switching native sessions inside Chat.',
  fork: 'Use Side chat from a message to create a separately tracked conversation.',
  rewind: 'Use Rewind from a message to restore the tracked conversation and/or files.',
  exit: 'Use the stop control if you want to stop this execution.',
  quit: 'Use the stop control if you want to stop this execution.',
  login: 'This interactive command is available in the remote Shell, not Chat.',
  logout: 'This interactive command is available in the remote Shell, not Chat.',
  theme: 'This terminal display command is not available in Chat.',
  'terminal-setup': 'This terminal display command is not available in Chat.',
};
const commandName = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_:/-]*$/i.test(value.replace(/^\//, '')) ? value.replace(/^\//, '') : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Command = { name: string; description: string; argumentHint: string };

/** Runtime and Commands use this bounded metadata-only cache; listing never starts Claude or sends input. */
export function createClaudeCommandCatalog() {
  const cache = new Map<string, Command[]>();
  const key = (sessionId: string, providerSessionId: string | null, projectPath: string) => JSON.stringify([sessionId, providerSessionId, path.resolve(projectPath)]);
  return {
    remember(sessionId: string, providerSessionId: string | null, projectPath: string, values: unknown): void {
      if (!Array.isArray(values)) return;
      const commands = new Map<string, Command>();
      for (const value of values.slice(0, 2000)) {
        const info = typeof value === 'string' ? { name: value } : record(value);
        for (const candidate of [info.name, ...(Array.isArray(info.aliases) ? info.aliases : [])]) {
          const name = commandName(candidate);
          if (!name) continue;
          const description = typeof info.description === 'string' ? info.description.slice(0, 1000) : DOCUMENTED_COMMANDS.find(item => item.name === name)?.description || 'Command reported by this remote Claude session.';
          commands.set(name, { name, description, argumentHint: typeof info.argumentHint === 'string' ? info.argumentHint.slice(0, 200) : '' });
        }
      }
      const identity = key(sessionId, providerSessionId, projectPath);
      cache.delete(identity);
      cache.set(identity, [...commands.values()]);
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
    },
    list(projectPath: string, sessionId?: string | null, providerSessionId?: string | null) {
      const reported = sessionId ? cache.get(key(sessionId, providerSessionId || null, projectPath)) : undefined;
      const commands = reported ?? DOCUMENTED_COMMANDS;
      return {
        native: commands.filter(command => !(command.name in UNAVAILABLE_COMMANDS)).map(command => ({
          name: `/${command.name}`, description: command.description, namespace: 'native', type: 'native',
          metadata: { type: reported ? 'remote' : 'documented', availability: reported ? 'reported' : 'documented', argumentHint: command.argumentHint },
        })),
        unavailable: Object.entries(UNAVAILABLE_COMMANDS).map(([name, reason]) => ({ name: `/${name}`, reason })),
        source: reported ? 'session' : 'documentation',
      };
    },
    assertAllowed(command: string, providerSessionId?: string | null) {
      const name = command.trimStart().match(/^\/([^\s]+)/)?.[1];
      if (!name) return;
      if (UNAVAILABLE_COMMANDS[name]) throw new Error(`/${name}: ${UNAVAILABLE_COMMANDS[name]}`);
      if (name === 'compact' && !providerSessionId) throw new Error('/compact needs an existing conversation with prior messages. Send a normal message first.');
    },
  };
}

/** Shared by the existing remote Claude runtime and the authenticated Commands module. */
export const claudeCommandCatalog = createClaudeCommandCatalog();
