import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmsMcpConnection, fingerprintMcpTarget } from '../mcp-auth-status.js';

test('native MCP health evidence must identify the selected scope and an exact connected status',()=>{
  for(const glyph of ['✓','✔','']) assert.equal(confirmsMcpConnection(`notion\nScope: Local config (private to you in this project)\nStatus: ${glyph} Connected\n`,'local'),true);
  assert.equal(confirmsMcpConnection('Scope: User config (available in all your projects)\nStatus: ✔ Connected','project'),false);
  assert.equal(confirmsMcpConnection('Scope: Project config (shared via .mcp.json)\nStatus: ! Needs authentication','project'),false);
  assert.equal(confirmsMcpConnection('Scope: Project config\nStatus: cached 2h ago · connects on first use','project'),false);
  assert.equal(confirmsMcpConnection('Scope: Managed config\nStatus: ✔ Connected','user'),false);
  assert.equal(confirmsMcpConnection('Status: Connected','user'),false);
  assert.equal(confirmsMcpConnection('Scope: User config\nIssue: Status: Connected','user'),false);
});

test('target fingerprint follows native scope precedence and changes when the selected endpoint changes',()=>{
  const user = {provider:'claude' as const,name:'notion',scope:'user' as const,transport:'http' as const,url:'https://user.example.test/mcp'};
  const local = {...user,scope:'local' as const,url:'https://local.example.test/mcp'};
  const scopes = {user:[user],local:[local],project:[]};
  assert.throws(()=>fingerprintMcpTarget(scopes,{name:'notion',scope:'user'}),/overridden/);
  const selected = fingerprintMcpTarget(scopes,{name:'notion',scope:'local'});
  assert.equal(selected,fingerprintMcpTarget({...scopes,user:[]},{name:'notion',scope:'local'}));
  assert.notEqual(selected,fingerprintMcpTarget({...scopes,local:[{...local,url:'https://changed.example.test/mcp'}]},{name:'notion',scope:'local'}));
  assert.throws(()=>fingerprintMcpTarget({user:[],local:[],project:[]},{name:'notion',scope:'local'}),/missing/);
});
