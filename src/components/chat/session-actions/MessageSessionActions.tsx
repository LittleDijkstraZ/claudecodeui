import { useTranslation } from 'react-i18next';
import { GitFork, MoreHorizontal, RotateCcw } from 'lucide-react';

import ActionMenu from '../../../shared/view/ui/ActionMenu';
import type { ActionMenuItem } from '../../../shared/view/ui/ActionMenu';
import type { ChatMessage } from '../types/types';

import { useClaudeSessionActions } from './ClaudeSessionActionsContext';

export default function MessageSessionActions({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat');
  const actions = useClaudeSessionActions();
  if (!actions?.enabled || message.isStreaming || message.isThinking || message.isToolUse || !['user', 'assistant'].includes(message.type)) return null;
  const saved = actions.isSavedMessage(message);
  const items: ActionMenuItem[] = [{
    key: 'side-chat', label: t('sessionActions.sideChat'), icon: GitFork,
    onSelect: () => actions.open('sideChat', message),
    disabled: (actions.busy && !actions.capabilities?.sideChatWhileRunning) || !saved || !actions.capabilities?.sideChat,
  }];
  if (message.type === 'user') {
    items.push({
      key: 'rewind', label: t('sessionActions.rewind'), icon: RotateCcw,
      onSelect: () => actions.open('rewind', message),
      disabled: actions.busy || !actions.isSavedMessage(message, true) || !actions.capabilities?.conversationRewind,
    });
  }
  const status = actions.status ?? (!saved ? t('sessionActions.notSaved') : null);
  return (
    <ActionMenu
      label={t('sessionActions.menu')}
      ariaLabel={t('sessionActions.menu')}
      items={items}
      icon={MoreHorizontal}
      iconOnly
      portal
      variant="ghost"
      triggerClassName="h-6 w-6 p-0 text-muted-foreground"
      menuClassName="w-64"
      onOpenChange={open => { if (open) actions.refresh(); }}
      header={status ? <p className="px-2 py-1.5 text-xs text-muted-foreground">{status}</p> : undefined}
    />
  );
}
