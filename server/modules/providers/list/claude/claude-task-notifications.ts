/** Preserve native task identity for the task panel without converting completion notices into new human turns. */
export function readClaudeTaskNotification(raw: Record<string, any>) {
  if (raw.type === 'system' && raw.subtype === 'task_notification' && typeof raw.task_id === 'string') {
    return { taskId: raw.task_id, toolUseId: raw.tool_use_id, status: raw.status ?? 'unknown', summary: raw.summary ?? '', content: raw.result ?? '', usage: raw.usage };
  }
  if (raw.message?.role !== 'user' || raw.origin?.kind === 'human') return null;
  const content = raw.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
  if (!text.trim().startsWith('<task-notification>') || !text.trim().endsWith('</task-notification>')) return null;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const taskId = tag('task-id');
  const toolUseId = tag('tool-use-id');
  if (!taskId && !toolUseId) return null;
  return { taskId, toolUseId, status: tag('status') || 'unknown', summary: tag('summary') || '', content: tag('result') || '', usage: tag('usage') };
}
