import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, FileCode2, History, Loader2, MessageSquare, X } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/shared/ui';
import type { ConversationChangeTurn, ConversationFileChange, DiffCalculator } from '@/shared/types';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import ConversationChangeContent from '@/modules/chat/changes/ConversationChangeContent';

type ConversationChangesBarProps = {
  turns: ConversationChangeTurn[];
  isProcessing: boolean;
  hasEarlierMessages: boolean;
  isLoadingEarlierMessages: boolean;
  onLoadAllMessages: () => void;
  onJumpToChange: (change: ConversationFileChange) => void;
};

type ChangeRecord = { change: ConversationFileChange; turn: ConversationChangeTurn };
type FileChanges = { path: string; records: ChangeRecord[] };

function formattedTime(value: unknown, language: string) {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function ChangeRecordView({ record, index, createDiff, onJump, showTurn }: {
  record: ChangeRecord;
  index: number;
  createDiff: DiffCalculator;
  onJump: (change: ConversationFileChange) => void;
  showTurn: boolean;
}) {
  const { t, i18n } = useTranslation('chat');
  const { change, turn } = record;
  const size = (change.oldContent?.length ?? 0) + (change.newContent?.length ?? 0) + (change.patch?.length ?? 0);
  // Keep the user's expansion choice while the underlying change records refresh.
  const [expanded, setExpanded] = useState(index < 3 && size <= 40_000);
  const contentId = useId();
  const time = formattedTime(change.timestamp, i18n.resolvedLanguage ?? 'en');

  return (
    <article className="space-y-2 rounded-lg bg-muted/20 p-2.5 sm:p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
          <span>{t('changes.editNumber', { number: index + 1 })}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-normal text-muted-foreground">{t(`changes.operation.${change.operation}`)}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          aria-label={t('changes.jumpNamed', { file: change.filePath, number: index + 1 })}
          onClick={() => onJump(change)}
        >
          <MessageSquare className="h-3 w-3" />{t('changes.jump')}
        </Button>
      </div>
      {(showTurn || change.contextLabel || time) && (
        <p className="break-words text-[11px] leading-relaxed text-muted-foreground">
          {showTurn && <span>{turn.label}{time ? ' · ' : ''}</span>}
          {time && <span>{time}</span>}
          {change.contextLabel && <span className="mt-0.5 block">{change.contextLabel}</span>}
        </p>
      )}
      {expanded ? (
        <div id={contentId}>
          <ConversationChangeContent change={change} createDiff={createDiff} />
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setExpanded(true)} aria-controls={contentId}>
          {t('changes.showEdit')}
        </Button>
      )}
    </article>
  );
}

function FileChangeGroup({ file, defaultExpanded, createDiff, onJump, showTurn }: {
  file: FileChanges;
  defaultExpanded: boolean;
  createDiff: DiffCalculator;
  onJump: (change: ConversationFileChange) => void;
  showTurn: boolean;
}) {
  const { t } = useTranslation('chat');
  // Keep the user's expansion choice while the underlying change records refresh.
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Bound the rendered edit cards until the user requests more records.
  const [visibleEdits, setVisibleEdits] = useState(10);
  const contentId = useId();

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 break-all font-mono text-xs leading-5">{file.path}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{t('changes.editCount', { count: file.records.length })}</span>
      </button>
      {expanded && (
        <div id={contentId} className="space-y-2 border-t border-border p-2 sm:p-3">
          {file.records.length > 1 && <p className="px-1 pb-1 text-[11px] text-muted-foreground">{t('changes.sequentialEdits')}</p>}
          {file.records.slice(0, visibleEdits).map((record, index) => (
            <ChangeRecordView key={record.change.id} record={record} index={index} createDiff={createDiff} onJump={onJump} showTurn={showTurn} />
          ))}
          {file.records.length > visibleEdits && (
            <Button type="button" variant="ghost" size="sm" className="w-full text-xs" onClick={() => setVisibleEdits((count) => count + 10)}>
              {t('changes.moreEdits', { count: file.records.length - visibleEdits })}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Used by chat's ChatInterface to summarize recorded edits and reveal their original context. */
export default function ConversationChangesBar({
  turns, isProcessing, hasEarlierMessages, isLoadingEarlierMessages, onLoadAllMessages, onJumpToChange,
}: ConversationChangesBarProps) {
  const { t, i18n } = useTranslation('chat');
  // Keep the changes review dialog open independently of streamed chat updates.
  const [isOpen, setIsOpen] = useState(false);
  // Select the current turn, an earlier turn, or all loaded changes for review.
  const [scope, setScope] = useState('latest');
  // Limit initial file card rendering for conversations with many edits.
  const [visibleFiles, setVisibleFiles] = useState(40);
  const id = useId();
  const pendingJumpRef = useRef<number | null>(null);
  const createDiff = useMemo(() => createCachedDiffCalculator(), []);
  const latestTurn = turns[turns.length - 1];
  const latestChangedTurn = [...turns].reverse().find((turn) => turn.changes.length > 0);
  const latestFileCount = new Set(latestTurn?.changes.map((change) => change.filePath) ?? []).size;
  const allEditCount = turns.reduce((count, turn) => count + turn.changes.length, 0);

  const files = useMemo(() => {
    const selectedTurns = scope === 'all'
      ? turns
      : scope === 'latest'
        ? latestTurn ? [latestTurn] : []
        : turns.filter((turn) => `turn:${turn.id}` === scope);
    const byFile = new Map<string, FileChanges>();
    for (const turn of selectedTurns) {
      for (const change of turn.changes) {
        const file = byFile.get(change.filePath) ?? { path: change.filePath, records: [] };
        file.records.push({ change, turn });
        byFile.set(change.filePath, file);
      }
    }
    return [...byFile.values()];
  }, [latestTurn, scope, turns]);
  const selectedEditCount = files.reduce((count, file) => count + file.records.length, 0);

  useEffect(() => () => {
    if (pendingJumpRef.current !== null) cancelAnimationFrame(pendingJumpRef.current);
  }, []);

  const jump = (change: ConversationFileChange) => {
    // Close the portal and let its focus restoration finish before the parent
    // expands the original tool card and scrolls to it in the conversation.
    flushSync(() => setIsOpen(false));
    pendingJumpRef.current = requestAnimationFrame(() => {
      pendingJumpRef.current = null;
      onJumpToChange(change);
    });
  };

  if (allEditCount === 0 && !hasEarlierMessages) return null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <div className="mx-auto mb-1 flex w-[calc(100%_-_1rem)] max-w-[54.25rem] justify-end sm:w-[calc(100%_-_2rem)]" data-testid="conversation-changes-bar">
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="h-6 max-w-full gap-1.5 px-2 text-[11px] text-muted-foreground" title={t('changes.review')}>
            <FileCode2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('changes.review')}{latestFileCount > 0 ? ` · ${t('changes.latestFiles', { count: latestFileCount })}` : allEditCount > 0 ? ` · ${t('changes.earlierEdits', { count: allEditCount })}` : ''}</span>
            {isProcessing && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label={t('changes.processing')} />}
          </Button>
        </DialogTrigger>
      </div>

      <DialogContent className="flex max-h-[90dvh] w-[calc(100%_-_1rem)] max-w-4xl flex-col overflow-hidden sm:w-[calc(100%_-_3rem)]" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
        <div className="shrink-0 space-y-3 border-b border-border px-4 py-4 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle id={`${id}-title`} className="not-sr-only text-base font-semibold">{t('changes.title')}</DialogTitle>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 shrink-0 p-0" aria-label={t('changes.close')} onClick={() => setIsOpen(false)}><X className="h-4 w-4" /></Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1 sm:max-w-md">
              <label htmlFor={`${id}-scope`} className="sr-only">{t('changes.scope')}</label>
              <select
                id={`${id}-scope`}
                value={scope}
                onChange={(event) => { setScope(event.target.value); setVisibleFiles(40); }}
                className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="latest">{t(isProcessing ? 'changes.currentTurn' : 'changes.latestTurn')}</option>
                <option value="all">{t('changes.allLoaded')}</option>
                {turns.slice(0, -1).reverse().map((turn) => (
                  <option key={turn.id} value={`turn:${turn.id}`}>
                    {turn.label.slice(0, 100)}{turn.timestamp ? ` · ${formattedTime(turn.timestamp, i18n.resolvedLanguage ?? 'en')}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground" role="status">{t('changes.fileCount', { count: files.length })} · {t('changes.editCount', { count: selectedEditCount })}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-5">
          {files.length === 0 ? (
            <div className="py-10 text-center">
              <FileCode2 className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
              <p className="text-sm">{t('changes.noChanges')}</p>
              {scope === 'latest' && latestChangedTurn && latestChangedTurn !== latestTurn && (
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setScope(`turn:${latestChangedTurn.id}`)}>{t('changes.viewPrevious')}</Button>
              )}
            </div>
          ) : files.slice(0, visibleFiles).map((file, index) => (
            <FileChangeGroup key={`${scope}:${file.path}`} file={file} defaultExpanded={index < 5} createDiff={createDiff} onJump={jump} showTurn={scope === 'all'} />
          ))}
          {files.length > visibleFiles && (
            <Button type="button" variant="outline" className="w-full text-xs" onClick={() => setVisibleFiles((count) => count + 40)}>{t('changes.moreFiles', { count: files.length - visibleFiles })}</Button>
          )}
        </div>

        <div className="shrink-0 space-y-2 border-t border-border bg-muted/15 px-4 py-3 sm:px-5">
          {(hasEarlierMessages || isLoadingEarlierMessages) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('changes.partialHistory')}</p>
              <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={isLoadingEarlierMessages} onClick={onLoadAllMessages}>
                {isLoadingEarlierMessages ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                {t(isLoadingEarlierMessages ? 'changes.loadingHistory' : 'changes.loadHistory')}
              </Button>
            </div>
          )}
          <p id={`${id}-description`} className="text-[11px] leading-relaxed text-muted-foreground">{t('changes.recordedOnly')}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
