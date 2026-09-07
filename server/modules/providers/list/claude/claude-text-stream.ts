import type { AnyRecord, NormalizedMessage } from '@/shared/index.js';

type DisplayedBlock = { signature: string | null; consumed: boolean };
type StreamingBlock = {
    index: number;
    type: string;
    part: AnyRecord;
    text: string;
    inputJson: string;
    closed: boolean;
    displayed: DisplayedBlock[];
};
type StreamingMessage = {
    id: string | undefined;
    blocks: Map<number, StreamingBlock>;
    stopped: boolean;
};

/** Used by the Claude runtime and provider tests to adapt SDK partial events without duplicating final blocks. */
export function createClaudeTextStream(normalizeComplete: (raw: unknown, sessionId: string | null) => NormalizedMessage[]) {
    const records = new Map<string, StreamingMessage>();
    let current: StreamingMessage | null = null;
    let activeBlock: StreamingBlock | null = null;

    function canonical(value: unknown): unknown {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as AnyRecord)[key])]));
        }
        return value;
    }

    function signature(item: Pick<NormalizedMessage, 'kind' | 'role' | 'content' | 'toolId' | 'toolName' | 'toolInput'>) {
        if (item.kind === 'text') return JSON.stringify(['text', item.role, item.content]);
        if (item.kind === 'thinking') return JSON.stringify(['thinking', item.content]);
        if (item.kind === 'tool_use') return JSON.stringify(['tool', item.toolId, item.toolName, canonical(item.toolInput)]);
        return null;
    }

    function end(sessionId: string | null, complete = false): NormalizedMessage[] {
        if (!activeBlock) return [];
        const block = activeBlock;
        activeBlock = null;
        block.closed = true;
        if (block.type === 'text') {
            if (!block.text.length) return [];
            block.displayed.push({ signature: signature({kind: 'text', role: 'assistant', content: block.text}), consumed: false });
            return normalizeComplete({ type: 'content_block_stop' }, sessionId);
        }
        // Only show non-text blocks once the SDK has actually completed them.
        // An error/early final snapshot must not turn incomplete tool JSON into a tool call.
        if (!complete) return [];
        const part = { ...block.part };
        if (block.type === 'thinking') part.thinking = block.text;
        else if (block.type === 'tool_use' && block.inputJson) {
            try { part.input = JSON.parse(block.inputJson); }
            catch { return []; }
        }
        const output = normalizeComplete({ type: 'assistant', uuid: `stream_${current?.id}_${block.index}`,
            message: { role: 'assistant', id: current?.id, content: [part] } }, sessionId);
        for (const item of output) {
            const key = signature(item);
            if (key) block.displayed.push({signature: key, consumed: false});
        }
        return output;
    }

    function collect(record: StreamingMessage | null | undefined) {
        if (record?.stopped && [...record.blocks.values()].every(b => b.displayed.every(d => d.consumed))) {
            if (record.id) records.delete(record.id);
        }
    }

    function normalize(message: AnyRecord, sessionId: string | null): NormalizedMessage[] {
        // The UI has one text accumulator per conversation: nested agents must never use it.
        if (message?.type === 'stream_event' && message.parent_tool_use_id) return [];
        if (message?.type === 'stream_event') {
            const event = message.event;
            if (!event) return [];
            if (event.type === 'message_start') {
                const output = end(sessionId);
                current = { id: event.message?.id, blocks: new Map(), stopped: false };
                if (current.id) {
                    records.set(current.id, current);
                    // Only a small number can await their authoritative SDK message at once.
                    while (records.size > 64) records.delete(records.keys().next().value!);
                }
                return output;
            }
            if (event.type === 'content_block_start') {
                const output = end(sessionId);
                if (!event.content_block) return output;
                const type = event.content_block.type;
                const block: StreamingBlock = { index: event.index, type, part: { ...event.content_block },
                    text: type === 'thinking' ? event.content_block.thinking || '' : '',
                    inputJson: '', closed: false, displayed: [] };
                current?.blocks.set(event.index, block);
                activeBlock = block;
                const text = event.content_block.text;
                if (type === 'text' && typeof text === 'string' && text.length) {
                    block.text += text;
                    output.push(...normalizeComplete({ type: 'content_block_delta', delta: { text } }, sessionId));
                }
                return output;
            }
            if (event.type === 'content_block_delta') {
                if (!activeBlock || activeBlock.index !== event.index) return [];
                if (activeBlock.type === 'thinking' && event.delta?.type === 'thinking_delta') {
                    activeBlock.text += event.delta.thinking || '';
                    return [];
                }
                if (activeBlock.type === 'tool_use' && event.delta?.type === 'input_json_delta') {
                    activeBlock.inputJson += event.delta.partial_json || '';
                    return [];
                }
                if (activeBlock.type !== 'text' || event.delta?.type !== 'text_delta') return [];
                const text = event.delta.text;
                if (typeof text !== 'string' || !text.length) return [];
                activeBlock.text += text;
                return normalizeComplete({ type: 'content_block_delta', delta: { text } }, sessionId);
            }
            if (event.type === 'content_block_stop') {
                return activeBlock?.index === event.index ? end(sessionId, true) : [];
            }
            if (event.type === 'message_stop') {
                const output = end(sessionId, true);
                if (current) {
                    current.stopped = true;
                    collect(current);
                    current = null;
                }
                return output;
            }
            return [];
        }

        const isMainAssistant = message?.type === 'assistant' && !message.parent_tool_use_id;
        const finishesCurrent = isMainAssistant && (!current?.id || message.message?.id === current.id);
        const output = finishesCurrent || message?.type === 'result' ? end(sessionId) : [];
        const record = isMainAssistant ? records.get(message.message?.id) : null;
        const complete = normalizeComplete(message, sessionId);
        for (const item of complete) {
            // Suppress only an exact, completed, already displayed text block from this message.
            // Keep mismatches and all tool/thinking messages so final authoritative output is never lost.
            const key = signature(item);
            const duplicate = record && key
                ? [...record.blocks.values()].flatMap(b => b.displayed).find(d => !d.consumed && d.signature === key)
                : null;
            if (duplicate) duplicate.consumed = true;
            else output.push(item);
        }
        collect(record);
        if (message?.type === 'result') {
            records.clear();
            current = null;
        }
        return output;
    }

    return { normalize, finish: end };
}
