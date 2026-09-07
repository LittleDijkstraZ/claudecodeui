import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { ToolDiffViewer } from '../../tools/components/ToolDiffViewer';
import type { ConversationFileChange } from '../../types/conversationChanges';
import type { DiffCalculator } from '../../utils/messageTransforms';

const PAGE_CHARACTERS = 16_000;
const PAGE_LINES = 200;
const DIFF_CHARACTERS = 40_000;
const DIFF_CELLS = 160_000;

/** The existing diff calculator allocates a quadratic LCS table. Bound both axes. */
function canRenderDiff(oldContent: string, newContent: string) {
  if (oldContent.length + newContent.length > DIFF_CHARACTERS) return false;
  const oldLines = oldContent.split('\n').length + 1;
  const newLines = newContent.split('\n').length + 1;
  return oldLines * newLines <= DIFF_CELLS && oldLines + newLines <= 600;
}

function textPageEnd(content: string, start: number) {
  const characterEnd = Math.min(content.length, start + PAGE_CHARACTERS);
  let end = start;
  for (let line = 0; line < PAGE_LINES; line += 1) {
    const nextNewline = content.indexOf('\n', end);
    if (nextNewline === -1 || nextNewline >= characterEnd) return characterEnd;
    end = nextNewline + 1;
  }
  return end;
}

function RecordedText({ content, label, patch = false }: { content: string; label: string; patch?: boolean }) {
  const { t } = useTranslation('chat');
  const [starts, setStarts] = useState([0]);
  const [page, setPage] = useState(0);
  const start = Math.min(starts[page] ?? 0, content.length);
  const end = textPageEnd(content, start);
  const hasMore = end < content.length;
  const text = content.slice(start, end);

  return (
    <section className="overflow-hidden rounded-lg border border-border" aria-label={label}>
      <h5 className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium">{label}</h5>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-background px-3 py-2 font-mono text-[11px] leading-5" tabIndex={0}>
        <code>{content.length === 0 ? t('changes.emptyContent') : patch ? text.split('\n').map((line, index) => (
          <span key={index} className={cn(
            'block',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-green-500/10 text-green-700 dark:text-green-300',
            line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/10 text-red-700 dark:text-red-300',
          )}>{line || '\u00a0'}</span>
        )) : text}</code>
      </pre>
      {(page > 0 || hasMore) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground">{t('changes.contentPage', { page: page + 1 })}</span>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{t('changes.previous')}</Button>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={!hasMore} onClick={() => {
              setStarts((current) => [...current.slice(0, page + 1), end]);
              setPage((value) => value + 1);
            }}>{t('changes.next')}</Button>
          </div>
          <p className="w-full text-[11px] text-muted-foreground">{t('changes.pagedContent')}</p>
        </div>
      )}
    </section>
  );
}

/** Renders only recorded material; an unknown pre-write file is never treated as empty. */
export default function ConversationChangeContent({ change, createDiff }: {
  change: ConversationFileChange;
  createDiff: DiffCalculator;
}) {
  const { t } = useTranslation('chat');
  const oldContent = change.oldContent;
  const newContent = change.newContent;
  const hasBothSides = typeof oldContent === 'string' && typeof newContent === 'string';

  if (hasBothSides && canRenderDiff(oldContent, newContent)) {
    if (oldContent === newContent) return <p className="text-xs text-muted-foreground">{t('changes.identical')}</p>;
    return (
      <div className="max-h-96 overflow-auto break-all">
        <ToolDiffViewer oldContent={oldContent} newContent={newContent} filePath={change.filePath} createDiff={createDiff} badge={t('changes.recordedDiff')} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasBothSides ? (
        <>
          <p className="text-xs text-muted-foreground">{t('changes.largeComparison')}</p>
          <RecordedText content={oldContent} label={t('changes.before')} />
          <RecordedText content={newContent} label={t('changes.after')} />
        </>
      ) : typeof change.patch === 'string' && change.patch.length > 0 ? (
        <RecordedText content={change.patch} label={t('changes.recordedPatch')} patch />
      ) : (
        <>
          {typeof newContent === 'string' && (
            <>
              <p className="text-xs text-muted-foreground">{t('changes.unknownBefore')}</p>
              <RecordedText content={newContent} label={t('changes.writtenContent')} />
            </>
          )}
          {typeof oldContent === 'string' && (
            <RecordedText content={oldContent} label={t(change.operation === 'delete' ? 'changes.beforeDeletion' : 'changes.before')} />
          )}
          {oldContent === undefined && newContent === undefined && <p className="text-xs text-muted-foreground">{t('changes.noRecordedContent')}</p>}
        </>
      )}
    </div>
  );
}
