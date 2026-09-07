import type { ConversationFileChange, DiffCalculator, DiffStats } from '@/shared/types';
import { summarizeDiff } from '@/modules/chat/utils/messageTransforms';

type CachedRecord = {
  oldContent?: string;
  newContent?: string;
  patch?: string;
  operation: ConversationFileChange['operation'];
  lineCountUnavailable?: boolean;
  stats: DiffStats | null;
};

const MAX_CACHED_RECORDS = 1_024;
const MAX_DIFF_CHARACTERS = 40_000;
const MAX_DIFF_CELLS = 160_000;
const MAX_DIFF_LINES = 600;

function lineCount(content: string): number {
  if (!content) return 0;
  let count = content.endsWith('\n') ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') count += 1;
  return count;
}

function recordedPatchStats(change: ConversationFileChange): DiffStats | null {
  if (!change.patch) return null;
  const lines = change.patch.replace(/\r\n/g, '\n').split('\n');
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let foundHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  const applyPatch = lines[0] === '*** Begin Patch' && lines.at(-1) === '*** End Patch';
  if (applyPatch) {
    const header = lines[1];
    // A move is shown at both paths; count its edits once at the destination.
    if (change.operation === 'delete' && lines.some(line => line.startsWith('*** Move to: '))) return { added: 0, removed: 0 };
    if (header?.startsWith('*** Delete File: ')) return null;
    if (!/^\*\*\* (?:Add|Update) File: /.test(header ?? '')) return null;
    for (const line of lines.slice(2, -1)) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
      else if (!/^(?: |@@|\*\*\* (?:Move to: |End of File$)|$)/.test(line)) return null;
    }
    return { added, removed };
  }
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) return null;
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      inHunk = true;
      foundHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (oldRemaining === 0 && newRemaining === 0) { inHunk = false; continue; }
    if (line.startsWith('+')) { added += 1; newRemaining -= 1; }
    else if (line.startsWith('-')) { removed += 1; oldRemaining -= 1; }
    else if (line.startsWith(' ')) { oldRemaining -= 1; newRemaining -= 1; }
    else return null;
    if (oldRemaining < 0 || newRemaining < 0) return null;
  }
  return foundHunk && oldRemaining === 0 && newRemaining === 0 ? { added, removed } : null;
}

function recordStats(change: ConversationFileChange, createDiff: DiffCalculator): DiffStats | null {
  const patchStats = recordedPatchStats(change);
  if (patchStats) return patchStats;
  if (change.lineCountUnavailable) return null;
  const { oldContent, newContent } = change;
  if (typeof oldContent !== 'string' || typeof newContent !== 'string') return null;
  if (oldContent === newContent) return { added: 0, removed: 0 };
  if (oldContent === '') return { added: lineCount(newContent), removed: 0 };
  if (newContent === '') return { added: 0, removed: lineCount(oldContent) };
  if (oldContent.length + newContent.length > MAX_DIFF_CHARACTERS) return null;
  const oldLines = oldContent.split('\n').length;
  const newLines = newContent.split('\n').length;
  // The shared renderer uses quadratic LCS. A compact badge must never allocate
  // an unbounded table merely because a long tool result arrived in the stream.
  if ((oldLines + 1) * (newLines + 1) > MAX_DIFF_CELLS || oldLines + newLines > MAX_DIFF_LINES) return null;
  return summarizeDiff(createDiff(oldContent, newContent));
}

/** Changes review uses this bounded cache to avoid re-diffing unchanged tool records on every streamed token. */
export function createConversationChangeStats(createDiff: DiffCalculator) {
  const cache = new Map<string, CachedRecord>();
  let previousChanges: ConversationFileChange[] = [];
  let previousTotals = { added: 0, removed: 0, unknown: 0, known: 0 };
  return (changes: ConversationFileChange[]) => {
    // The extractor recreates records as prose streams. Compare existing strings
    // directly before parsing, including selections larger than the record cache.
    if (changes.length === previousChanges.length && changes.every((change, index) => {
      const previous = previousChanges[index];
      return previous.id === change.id && previous.oldContent === change.oldContent && previous.newContent === change.newContent
        && previous.patch === change.patch && previous.operation === change.operation && previous.lineCountUnavailable === change.lineCountUnavailable;
    })) return previousTotals;
    let added = 0;
    let removed = 0;
    let unknown = 0;
    for (const change of changes) {
      let cached = cache.get(change.id);
      if (!cached || cached.oldContent !== change.oldContent || cached.newContent !== change.newContent
        || cached.patch !== change.patch || cached.operation !== change.operation || cached.lineCountUnavailable !== change.lineCountUnavailable) {
        cached = { oldContent: change.oldContent, newContent: change.newContent, patch: change.patch,
          operation: change.operation, lineCountUnavailable: change.lineCountUnavailable, stats: recordStats(change, createDiff) };
        cache.set(change.id, cached);
        if (cache.size > MAX_CACHED_RECORDS) cache.delete(cache.keys().next().value!);
      }
      if (cached.stats) { added += cached.stats.added; removed += cached.stats.removed; }
      else unknown += 1;
    }
    previousChanges = changes;
    previousTotals = { added, removed, unknown, known: changes.length - unknown };
    return previousTotals;
  };
}
