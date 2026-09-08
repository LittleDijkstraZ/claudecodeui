import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpAuthService } from '../mcp-auth.service.js';

const target = { name: 'notion-fixture', scope: 'user' };
const authUrl = 'https://auth.example.test/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A63649%2Fcallback&state=fixture-state&code_challenge=fixture-pkce';
const callback = 'http://localhost:63649/callback?code=fixture-code&state=fixture-state';
function fixture() {
  let data: (chunk: string) => void = () => {}; let exit: (code: number) => void = () => {};
  let now = 10_000; let checks = 0; let connected = true; const writes: string[] = []; let killed = 0;
  const service = createMcpAuthService({ now: () => now,
    resolveTarget: async () => ({ cwd: '/remote/project' }),
    launch: (_target, onData, onExit) => { data = onData; exit = onExit; return { write: value => writes.push(value), kill: () => { killed++; } }; },
    connected: async () => { checks++; return connected; },
  });
  return { service, data: (value: string) => data(value), exit: (value: number) => exit(value), writes, get checks() { return checks; }, get killed() { return killed; }, tick: () => { now += 610_000; }, failCheck: () => { connected = false; } };
}

test('auth is remote-native and only a real successful remote health check marks connected', async () => {
  const f = fixture(); const attempt = await f.service.start(1, target);
  assert.equal(attempt.status, 'starting');
  f.data(authUrl.slice(0, 95)); assert.equal(f.service.read(1,attempt.id).authorizationUrl,null);
  f.data(authUrl.slice(95) + '\n'); assert.equal(f.service.read(1,attempt.id).status,'awaiting-browser');
  assert.equal(f.service.callback(1, attempt.id, callback).status,'verifying');
  assert.deepEqual(f.writes,[callback+'\r']); assert.equal(f.checks,0);
  f.exit(0); await Promise.resolve();
  assert.equal(f.service.read(1,attempt.id).status,'connected'); assert.equal(f.checks,1);
  assert.equal(f.service.read(1,attempt.id).authorizationUrl,null); f.service.close();
});
test('callbacks cannot cross owner, state, port, protocol, or paths', async () => {
  const f=fixture(); const attempt=await f.service.start(1,target);f.data(authUrl+'\n');
  assert.throws(()=>f.service.read(2,attempt.id),/not found/);
  for (const value of [callback.replace('fixture-state','other'),callback.replace('63649','63650'),callback.replace('localhost','evil.test'),callback.replace('/callback','/admin'),callback+'&state=fixture-state',callback+'\nwhoami']) {
    assert.throws(()=>f.service.callback(1,attempt.id,value));
  }
  assert.equal(f.writes.length,0);f.service.close();
});
test('unrecognized external callbacks never become authorization links', async () => {
  const f=fixture();const attempt=await f.service.start(1,target);
  f.data(authUrl.replace('localhost','evil.test')+'\n');
  assert.equal(f.service.read(1,attempt.id).authorizationUrl,null);f.service.close();
});
test('timeout stops only its native attempt and requires a fresh link', async () => {
  const f=fixture();const attempt=await f.service.start(1,target);f.data(authUrl+'\n');f.tick();
  assert.equal(f.service.read(1,attempt.id).status,'expired');assert.equal(f.killed,1);
  assert.throws(()=>f.service.callback(1,attempt.id,callback),/no longer/);
  f.exit(0);await Promise.resolve();assert.equal(f.checks,0);f.service.close();
});
test('a browser success cannot override a failed remote MCP health check', async () => {
  const f=fixture();const attempt=await f.service.start(1,target);f.data(authUrl+'\n');
  f.service.callback(1,attempt.id,callback);f.failCheck();f.exit(0);await Promise.resolve();
  assert.equal(f.service.read(1,attempt.id).status,'failed');f.service.close();
});
test('duplicate sign-ins are rejected and cancellation frees the remote for retry', async () => {
  const f=fixture();const attempt=await f.service.start(1,target);
  await assert.rejects(f.service.start(1,target),/already has/);
  f.service.cancel(1,attempt.id);assert.equal(f.service.read(1,attempt.id).status,'cancelled');
  assert.notEqual((await f.service.start(1,target)).id,attempt.id);f.service.close();
});

test('login and health verification keep the same remote folder, scope, and configuration snapshot',async()=>{
  const launched: unknown[]=[];const checked: unknown[]=[];const exits:Array<(code:number)=>void>=[];
  const service=createMcpAuthService({
    resolveTarget:async target=>({cwd:target.workspacePath!,configFingerprint:`fixture-${target.workspacePath}`}),
    launch:(target,_data,exit)=>{launched.push(target);exits.push(exit);return{write:()=>{},kill:()=>{}};},
    connected:async target=>{checked.push(target);return true;},
  });
  try {
    const first=await service.start(1,{name:'same-name',scope:'project',workspacePath:'/remote/alpha/project'});
    const second=await service.start(1,{name:'same-name',scope:'project',workspacePath:'/remote/beta/project'});
    exits[1](0);exits[0](0);await Promise.resolve();
    assert.deepEqual(checked,[launched[1],launched[0]]);
    assert.equal(service.read(1,first.id).workspacePath,'/remote/alpha/project');
    assert.equal(service.read(1,second.id).workspacePath,'/remote/beta/project');
  } finally {service.close();}
});
