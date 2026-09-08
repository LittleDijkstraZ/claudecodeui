import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeTextStream } from '@/modules/providers/list/claude/claude-text-stream.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { AnyRecord, NormalizedMessage } from '@/shared/index.js';

const session = 'streaming-fixture';
const partial = (event: AnyRecord, parent: string | null = null) => ({type:'stream_event',session_id:session,parent_tool_use_id:parent,event});
const start = (id: string) => partial({type:'message_start',message:{id}});
const begin = (index: number,part: AnyRecord={type:'text',text:''}) => partial({type:'content_block_start',index,content_block:part});
const delta = (index: number,text: string) => partial({type:'content_block_delta',index,delta:{type:'text_delta',text}});
const stop = (index: number) => partial({type:'content_block_stop',index});
const done = () => partial({type:'message_stop'});
const full = (id: string,content: AnyRecord[],parent: string | null=null) => ({type:'assistant',uuid:'fixture-'+id,message:{id,role:'assistant',content},parent_tool_use_id:parent});
const text = (value: string) => ({type:'text',text:value});

function harness() {
    const provider = new ClaudeSessionsProvider();
    const stream = createClaudeTextStream((raw,sid)=>provider.normalizeMessage(raw,sid));
    const events: NormalizedMessage[] = [];
    return { events, stream, send(raw: AnyRecord) { const result=stream.normalize(raw,session); events.push(...result); return result; } };
}
function display(events: NormalizedMessage[]) {
    let pending=''; const result: unknown[][]=[];
    const streamedRows = new Map<string, number>();
    const blockKey = (event: NormalizedMessage) => event.responseMessageId && event.contentBlockIndex !== undefined
        ? JSON.stringify([event.responseMessageId, event.contentBlockIndex]) : null;
    for (const e of events) {
        assert.equal(e.sessionId,session);
        assert.equal(e.provider,'claude');
        assert.ok(e.id && e.timestamp);
        if(e.kind==='stream_delta')pending+=e.content;
        else if(e.kind==='stream_end'){
            if(pending){const key=blockKey(e);if(key)streamedRows.set(key,result.length);result.push(['text',pending]);}
            pending='';
        }
        else if(e.kind==='text'){
            const key=blockKey(e);const streamed=key ? streamedRows.get(key) : undefined;
            if(streamed !== undefined)result[streamed]=['text',e.content];
            else result.push(['text',e.content]);
        }
        else if(e.kind==='thinking')result.push(['thinking',e.content]);
        else if(e.kind==='tool_use')result.push(['tool',e.toolId,e.toolInput]);
        else if(e.kind==='tool_result')result.push(['result',e.toolId,e.content]);
    }
    return {result,pending};
}

test('real SDK ordering: deltas display before full assistant, which arrives before block stop',()=>{
    const h=harness();h.send(start('m1'));h.send(begin(0));
    assert.equal(h.send(delta(0,'你好'))[0].content,'你好');
    h.send(delta(0,' 🌏'));
    assert.equal(display(h.events).pending,'你好 🌏');
    h.send(full('m1',[text('你好 🌏')]));h.send(stop(0));h.send(done());
    assert.deepEqual(display(h.events),{result:[['text','你好 🌏']],pending:''});
});
test('multiple pending identical text blocks keep authoritative rows without guessing their global indices',()=>{
    const h=harness();h.send(start('m2'));
    for(const i of [0,1]){h.send(begin(i));h.send(delta(i,'same'));h.send(stop(i));}
    h.send(done());h.send(full('m2',[text('same'),text('same')]));
    assert.deepEqual(display(h.events.filter(event => event.kind !== 'text')).result,[['text','same'],['text','same']]);
    const authoritative=h.events.filter(event => event.kind==='text');
    assert.deepEqual(authoritative.map(event => [event.id,event.content,event.contentBlockIndex]),[
        ['fixture-m2_0','same',undefined],['fixture-m2_1','same',undefined],
    ]);
});
test('mixed thinking, text, complete tool JSON, text retain block order and final tool metadata',()=>{
    const h=harness();h.send(start('m3'));
    h.send(begin(0,{type:'thinking',thinking:''}));
    h.send(partial({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'fixture thought'}}));h.send(stop(0));
    h.send(begin(1));h.send(delta(1,'Before'));h.send(stop(1));
    h.send(begin(2,{type:'tool_use',id:'tool-fixture',name:'Read',input:{}}));
    h.send(partial({type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"path":"fixture","limit":1}'}}));h.send(stop(2));
    h.send(begin(3));h.send(delta(3,'After'));h.send(stop(3));h.send(done());
    h.send(full('m3',[{type:'thinking',thinking:'fixture thought'},text('Before'),{type:'tool_use',id:'tool-fixture',name:'Read',input:{limit:1,path:'fixture'}},text('After')]));
    assert.deepEqual(display(h.events.filter(event => event.kind !== 'text')).result,[['thinking','fixture thought'],['text','Before'],['tool','tool-fixture',{path:'fixture',limit:1}],['text','After']]);
    assert.deepEqual(h.events.filter(event=>event.kind==='text').map(event=>[event.content,event.contentBlockIndex]),[
        ['Before',undefined],['After',undefined],
    ]);
});
test('early authoritative tool message is shown once even before block stop',()=>{
    const h=harness();h.send(start('m4'));h.send(begin(0,{type:'tool_use',id:'early',name:'Read',input:{}}));
    h.send(partial({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":"fixture"}'}}));
    h.send(full('m4',[{type:'tool_use',id:'early',name:'Read',input:{path:'fixture'}}]));h.send(stop(0));h.send(done());
    assert.deepEqual(display(h.events).result,[['tool','early',{path:'fixture'}]]);
});
test('subagent deltas cannot mix into main text, but authoritative nested output is retained',()=>{
    const h=harness();h.send(start('main'));h.send(begin(0));h.send(delta(0,'Main'));
    const nested=delta(0,'Hidden child partial');nested.parent_tool_use_id='agent-tool';assert.deepEqual(h.send(nested),[]);
    h.send(full('main',[text('Main')]));h.send(full('child',[text('Child result')],'agent-tool'));
    assert.deepEqual(display(h.events).result,[['text','Main'],['text','Child result']]);
});
test('same text in another message is not incorrectly suppressed',()=>{
    const h=harness();h.send(start('first'));h.send(begin(0));h.send(delta(0,'Repeated'));h.send(stop(0));h.send(done());
    h.send(full('other',[text('Repeated')]));h.send(full('first',[text('Repeated')]));
    assert.deepEqual(display(h.events).result,[['text','Repeated'],['text','Repeated']]);
});
test('a delayed final snapshot cannot close a newer message stream',()=>{
    const h=harness();h.send(start('old'));h.send(begin(0));h.send(delta(0,'Old'));h.send(stop(0));h.send(done());
    h.send(start('new'));h.send(begin(0));h.send(delta(0,'New'));
    h.send(full('old',[text('Old')]));h.send(delta(0,' continues'));
    h.send(full('new',[text('New continues')]));h.send(stop(0));h.send(done());
    assert.deepEqual(display(h.events),{result:[['text','Old'],['text','New continues']],pending:''});
});
test('nonempty starting text streams and mismatched authoritative text remains visible',()=>{
    const h=harness();h.send(start('m6'));h.send(begin(0,{type:'text',text:'Initial'}));h.send(delta(0,' partial'));h.send(stop(0));
    h.send(full('m6',[text('Corrected authoritative response')]));
    assert.deepEqual(display(h.events).result,[['text','Initial partial'],['text','Corrected authoritative response']]);
});
test('error/abort flush is idempotent and never fabricates an incomplete tool call',()=>{
    const h=harness();h.send(start('m7'));h.send(begin(0));h.send(delta(0,'Partial'));
    h.events.push(...h.stream.finish(session));h.events.push(...h.stream.finish(session));
    h.send(begin(1,{type:'tool_use',id:'incomplete',name:'Write',input:{}}));
    h.send(partial({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":'}}));
    h.events.push(...h.stream.finish(session));
    assert.deepEqual(display(h.events),{result:[['text','Partial']],pending:''});
});
test('malformed incremental tool JSON falls back to authoritative complete tool call',()=>{
    const h=harness();h.send(start('m8'));h.send(begin(0,{type:'tool_use',id:'fallback',name:'Read',input:{}}));
    h.send(partial({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":'}}));h.send(stop(0));
    h.send(full('m8',[{type:'tool_use',id:'fallback',name:'Read',input:{path:'safe'}}]));
    assert.deepEqual(display(h.events).result,[['tool','fallback',{path:'safe'}]]);
});
test('ordinary complete responses and tool results keep working when partial events are absent',()=>{
    const h=harness();h.send(full('legacy',[text('Complete only')]));
    h.send({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:'result-tool',content:'ok'}]}});
    assert.deepEqual(display(h.events).result,[['text','Complete only'],['result','result-tool','ok']]);
});
test('separate conversations have separate stream buffers',()=>{
    const a=harness(),b=harness();a.send(start('same'));b.send(start('same'));a.send(begin(0));b.send(begin(0));
    a.send(delta(0,'A'));b.send(delta(0,'B'));a.send(full('same',[text('A')]));b.send(full('same',[text('B')]));
    assert.deepEqual(display(a.events).result,[['text','A']]);assert.deepEqual(display(b.events).result,[['text','B']]);
});

test('live text keeps exact response and block identity through initial text, deltas and stops', () => {
    const h = harness();
    h.send(start('api-multiple-blocks'));
    h.send(begin(0, text('Initial')));
    h.send(delta(0, ' tail'));
    h.send(stop(0));
    h.send(begin(1, { type: 'thinking', thinking: 'Private block' }));
    h.send(stop(1));
    h.send(begin(2));
    h.send(delta(2, 'Last'));
    h.send(stop(2));
    const streamed = h.events.filter(event => event.kind === 'stream_delta' || event.kind === 'stream_end');
    assert.deepEqual(streamed.map(event => [event.kind, event.responseMessageId, event.contentBlockIndex]), [
        ['stream_delta', 'api-multiple-blocks', 0],
        ['stream_delta', 'api-multiple-blocks', 0],
        ['stream_end', 'api-multiple-blocks', 0],
        ['stream_delta', 'api-multiple-blocks', 2],
        ['stream_end', 'api-multiple-blocks', 2],
    ]);
    assert.ok(streamed.every(event => !event.transcriptAnchorId));
});

test('closing an older block keeps its identity before a new response replaces it', () => {
    const h = harness();
    h.send(start('first-api'));
    h.send(begin(0));
    h.send(delta(0, 'First'));
    const [endFirst] = h.send(start('second-api'));
    assert.equal(endFirst.responseMessageId, 'first-api');
    assert.equal(endFirst.contentBlockIndex, 0);
    h.send(begin(0));
    h.send(delta(0, 'Second'));
    const [endSecond] = h.stream.finish(session);
    assert.equal(endSecond.responseMessageId, 'second-api');
    assert.equal(endSecond.contentBlockIndex, 0);
});

test('missing response IDs stay unknown and nested partials cannot replace main stream identity', () => {
    const h = harness();
    h.send(partial({ type: 'message_start', message: {} }));
    h.send(begin(0));
    const [anonymous] = h.send(delta(0, 'Anonymous'));
    assert.equal(anonymous.responseMessageId, undefined);
    assert.equal(anonymous.contentBlockIndex, 0);
    assert.equal(h.send(stop(0))[0].responseMessageId, undefined);
    h.send(start('main-api'));
    h.send(begin(0));
    h.send(delta(0, 'Main'));
    for (const event of [start('child-api'), begin(1), delta(1, 'Child'), stop(1)]) {
        assert.deepEqual(h.send({ ...event, parent_tool_use_id: 'agent-tool' }), []);
    }
    const [mainEnd] = h.send(stop(0));
    assert.equal(mainEnd.responseMessageId, 'main-api');
    assert.equal(mainEnd.contentBlockIndex, 0);
    const [child] = h.send(full('child-api', [text('Child result')], 'agent-tool'));
    assert.equal(child.responseMessageId, 'child-api');
    assert.equal(child.contentBlockIndex, undefined);
    assert.equal(child.transcriptAnchorId, undefined);
});

test('single-block SDK rows bridge native identities both before and after stream stop', () => {
    const h = harness();
    h.send(start('shared-api'));
    h.send(begin(0));
    h.send(delta(0, 'First'));
    const first = h.send({ ...full('shared-api', [text('First')]), uuid: 'native-first' });
    h.send(stop(0));
    h.send(begin(2));
    h.send(delta(2, 'Second'));
    h.send(stop(2));
    const second = h.send({ ...full('shared-api', [text('Second')]), uuid: 'native-second' });
    const authoritative = [...first, ...second].filter(event => event.kind === 'text');
    assert.deepEqual(authoritative.map(event => [event.id, event.responseMessageId, event.contentBlockIndex]), [
        ['native-first_0', 'shared-api', 0], ['native-second_0', 'shared-api', 2],
    ]);
    assert.ok(authoritative.every(event => event.transcriptAnchorId === undefined));
    assert.deepEqual(display(h.events).result, [['text', 'First'], ['text', 'Second']]);
});

test('ambiguous pending blocks are not correlated by text or progressively guessed as FIFO', () => {
    const h = harness();
    h.send(start('ambiguous-api'));
    for (const [index, content] of ['First', 'Second'].entries()) {
        h.send(begin(index)); h.send(delta(index, content)); h.send(stop(index));
    }
    const first = h.send({ ...full('ambiguous-api', [text('First')]), uuid: 'ambiguous-first' });
    const second = h.send({ ...full('ambiguous-api', [text('Second')]), uuid: 'ambiguous-second' });
    const authoritative = [...first, ...second].filter(event => event.kind === 'text');
    assert.deepEqual(authoritative.map(event => [event.id, event.content, event.contentBlockIndex]), [
        ['ambiguous-first_0', 'First', undefined], ['ambiguous-second_0', 'Second', undefined],
    ]);
});
