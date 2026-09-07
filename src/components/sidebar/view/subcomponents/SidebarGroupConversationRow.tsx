import type { ButtonHTMLAttributes, HTMLAttributes, MouseEvent } from 'react';
import { Archive, ArrowDown, ArrowUp, FolderInput, FolderMinus, MoreHorizontal } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { GroupConversation } from '../../../../types/conversationGroups';
import LLMProviderLogo from '../../../llm-provider-logo/LLMProviderLogo';
import { formatCompactAge } from '../../utils/utils';

type SidebarGroupConversationRowProps = {
  conversation: GroupConversation;
  groupId: string;
  selected: boolean;
  currentTime: Date;
  disabled: boolean;
  isDragging: boolean;
  dropPosition?: 'before' | 'after';
  dragRowProps: HTMLAttributes<HTMLDivElement>;
  dragHandleProps: ButtonHTMLAttributes<HTMLButtonElement>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: (projectId: string | null, sessionId: string, provider: string) => void;
  onOpenAssignment: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  t: TFunction;
};

/** One compact row; its menu manages membership and order, never conversation deletion. */
export default function SidebarGroupConversationRow({
  conversation, groupId, selected, currentTime, disabled, isDragging, dropPosition,
  dragRowProps, dragHandleProps, canMoveUp, canMoveDown,
  onSelect, onOpenAssignment, onRemove, onMoveUp, onMoveDown, t,
}: SidebarGroupConversationRowProps) {
  const age = formatCompactAge(conversation.lastActivity, currentTime);
  const tooltip = [
    conversation.sessionTitle,
    conversation.projectPath || conversation.projectDisplayName,
    conversation.isArchived ? t('groups.archived') : '',
  ].filter(Boolean).join('\n');
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onSelect(conversation.projectId, conversation.sessionId, conversation.provider);
  };

  return (
    <div
      {...dragRowProps}
      data-testid="group-conversation-row"
      data-group-id={groupId}
      data-session-id={conversation.sessionId}
      className={cn(
        'group relative flex h-8 min-w-0 items-center gap-1 rounded-md px-1 hover:bg-accent/60',
        selected && 'bg-primary/10',
        isDragging && 'opacity-50',
      )}
    >
      {dropPosition && <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded bg-primary', dropPosition === 'before' ? 'top-0' : 'bottom-0')} />}
      <button
        {...dragHandleProps}
        type="button"
        disabled={disabled}
        aria-label={t('groups.reorderNamed', { name: conversation.sessionTitle })}
        title={t('groups.dragToReorder')}
        className="flex h-7 w-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default"
      >
        <LLMProviderLogo provider={conversation.provider} className="h-3.5 w-3.5" />
      </button>
      <a
        href={`/session/${encodeURIComponent(conversation.sessionId)}`}
        draggable={false}
        onClick={open}
        aria-current={selected ? 'page' : undefined}
        title={tooltip}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate text-[13px] leading-4">{conversation.sessionTitle}</span>
        {conversation.isArchived && <Archive className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('groups.archived')} />}
        {age && <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70" dateTime={conversation.lastActivity ?? undefined}>{age}</time>}
      </a>
      <ActionMenu
        label={t('groups.conversationOptions')}
        ariaLabel={t('groups.conversationOptionsNamed', { name: conversation.sessionTitle })}
        icon={MoreHorizontal}
        iconOnly
        portal
        variant="ghost"
        disabled={disabled}
        triggerClassName="h-7 w-7 shrink-0 p-0 text-muted-foreground"
        items={[
          { key: 'move-group', label: t('groups.moveConversation'), icon: FolderInput, onSelect: onOpenAssignment },
          { key: 'remove-group', label: t('groups.removeConversation'), icon: FolderMinus, onSelect: onRemove },
          { key: 'move-up', label: t('groups.moveUp'), icon: ArrowUp, showDividerBefore: true, disabled: !canMoveUp, onSelect: onMoveUp },
          { key: 'move-down', label: t('groups.moveDown'), icon: ArrowDown, disabled: !canMoveDown, onSelect: onMoveDown },
        ]}
      />
    </div>
  );
}
