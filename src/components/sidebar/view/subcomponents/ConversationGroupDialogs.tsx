import { useState } from 'react';
import { Folder, Layers, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConversationGroups } from '../../../../contexts/ConversationGroupsContext';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import type { LLMProvider, Project } from '../../../../types/app';
import type { CreatedGroupConversation } from '../../../../types/conversationGroups';
import { createGroupConversation } from '../../../../utils/conversationGroupsApi';

type ConversationGroupDialogsProps = {
  projects: Project[];
  selectedProject: Project | null;
  onCreated: (conversation: CreatedGroupConversation, project: Project) => void;
};

const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

function AssignConversationDialog({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('common');
  const { groups, memberships, assignSession, createGroup, closeDialog, isLoading, error: loadError, refresh } = useConversationGroups();
  // Follow the loaded membership until the user actually chooses a destination.
  // Opening this dialog before the initial fetch must not default an existing
  // member to "No group" once that fetch finishes.
  const [groupId, setGroupId] = useState<string | null>(null);
  const selectedGroupId = groupId ?? memberships[sessionId] ?? '';
  const [isNewGroup, setIsNewGroup] = useState(false);
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      let target = selectedGroupId;
      if (isNewGroup) {
        const group = await createGroup(name.trim());
        target = group.id;
        // If assignment fails, a retry should reuse the group just created.
        setGroupId(target);
        setIsNewGroup(false);
      }
      await assignSession(sessionId, target || null);
      closeDialog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('conversationGroups.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSaving) closeDialog(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto p-5" aria-labelledby="assign-group-title" aria-describedby="assign-group-description">
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <DialogTitle id="assign-group-title" className="not-sr-only flex items-center gap-2 text-lg font-semibold">
            <Layers className="h-5 w-5 text-primary" />{t('conversationGroups.moveToGroup')}
          </DialogTitle>
          <p id="assign-group-description" className="text-sm text-muted-foreground">{t('conversationGroups.assignmentDescription')}</p>
          <div className="space-y-2">
            <label htmlFor="assignment-group" className="block text-sm font-medium">{t('conversationGroups.group')}</label>
            <select id="assignment-group" className={SELECT_CLASS} value={isNewGroup ? '__new__' : selectedGroupId} disabled={isSaving || isLoading || Boolean(loadError)} onChange={(event) => {
              setIsNewGroup(event.target.value === '__new__');
              if (event.target.value !== '__new__') setGroupId(event.target.value);
            }}>
              <option value="">{t('conversationGroups.ungrouped')}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              <option value="__new__">+ {t('conversationGroups.createGroup')}</option>
            </select>
          </div>
          {isNewGroup && <div className="space-y-2">
            <label htmlFor="assignment-group-name" className="block text-sm font-medium">{t('conversationGroups.groupName')}</label>
            <Input id="assignment-group-name" value={name} maxLength={80} required autoFocus disabled={isSaving} onChange={(event) => setName(event.target.value)} placeholder={t('conversationGroups.groupNamePlaceholder')} />
          </div>}
          {(error || loadError) && <div role="alert" className="space-y-1 text-sm text-destructive">
            <p>{error || loadError}</p>
            {loadError && <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>{t('conversationGroups.retry')}</Button>}
          </div>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={isSaving} onClick={closeDialog}>{t('conversationGroups.cancel')}</Button>
            <Button type="submit" disabled={isSaving || isLoading || Boolean(loadError) || (isNewGroup && !name.trim())}>
              {isSaving && <Loader2 className="animate-spin" />}{t('conversationGroups.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewGroupConversationDialog({ groupId, projects, selectedProject, onCreated }: ConversationGroupDialogsProps & { groupId: string }) {
  const { t } = useTranslation('common');
  const { groups, closeDialog, refresh } = useConversationGroups();
  const group = groups.find((item) => item.id === groupId);
  const [projectId, setProjectId] = useState(selectedProject?.projectId ?? projects[0]?.projectId ?? '');
  const [provider, setProvider] = useState<LLMProvider>('claude');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((item) => item.projectId === projectId);

  const create = async () => {
    if (isSaving || !project || !group) return;
    setIsSaving(true);
    setError(null);
    try {
      const conversation = await createGroupConversation(groupId, provider, project.fullPath || project.path || '');
      onCreated(conversation, project);
      closeDialog();
      void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('conversationGroups.createFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !isSaving) closeDialog(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto p-5" aria-labelledby="new-group-conversation-title" aria-describedby="new-group-conversation-description">
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <DialogTitle id="new-group-conversation-title" className="not-sr-only text-lg font-semibold">{t('conversationGroups.newConversation')}</DialogTitle>
          <p id="new-group-conversation-description" className="break-words text-sm text-muted-foreground">{t('conversationGroups.newConversationDescription', { group: group?.name ?? '' })}</p>
          <div className="space-y-2">
            <label htmlFor="group-conversation-folder" className="flex items-center gap-2 text-sm font-medium"><Folder className="h-4 w-4" />{t('conversationGroups.workingFolder')}</label>
            <select id="group-conversation-folder" className={SELECT_CLASS} value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={isSaving || projects.length === 0} required>
              <option value="" disabled>{t('conversationGroups.chooseFolder')}</option>
              {projects.map((item) => <option key={item.projectId} value={item.projectId}>{item.displayName} — {item.fullPath || item.path}</option>)}
            </select>
            {project && <p className="break-all text-xs text-muted-foreground">{project.fullPath || project.path}</p>}
            {projects.length === 0 && <p className="text-sm text-muted-foreground">{t('conversationGroups.noFolders')}</p>}
          </div>
          <div className="space-y-2">
            <label htmlFor="group-conversation-provider" className="block text-sm font-medium">{t('conversationGroups.provider')}</label>
            <select id="group-conversation-provider" className={SELECT_CLASS} value={provider} onChange={(event) => setProvider(event.target.value as LLMProvider)} disabled={isSaving}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="cursor">Cursor</option>
              <option value="opencode">OpenCode</option>
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={isSaving} onClick={closeDialog}>{t('conversationGroups.cancel')}</Button>
            <Button type="submit" disabled={isSaving || !project || !group}>
              {isSaving && <Loader2 className="animate-spin" />}{t('conversationGroups.createConversation')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ConversationGroupDialogs(props: ConversationGroupDialogsProps) {
  const { dialog } = useConversationGroups();
  if (dialog?.kind === 'assign') return <AssignConversationDialog key={dialog.sessionId} sessionId={dialog.sessionId} />;
  if (dialog?.kind === 'new') return <NewGroupConversationDialog key={dialog.groupId} groupId={dialog.groupId} {...props} />;
  return null;
}
