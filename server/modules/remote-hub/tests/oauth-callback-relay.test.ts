import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createOAuthCallbackRelay } from '../oauth-callback-relay.js';

const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port)));
const close = (server: http.Server) => new Promise<void>(resolve=>server.close(()=>resolve()));
async function freePort() {const server=http.createServer();const port=await listen(server);await close(server);return port;}
function call(port:number,path:string,host=`localhost:${port}`) {return new Promise<{status:number;body:string}>((resolve,reject)=>{
  http.get({hostname:'127.0.0.1',port,path,headers:{host}},response=>{let body='';response.on('data',chunk=>body+=String(chunk));response.on('end',()=>resolve({status:response.statusCode || 0,body}));}).on('error',reject);
});}
test('loopback OAuth callbacks remain fixed to their verified remote attempt and require its exact state', async () => {
  const callbackPort=await freePort();const received:string[]=[];const id='fixture-attempt';
  const remote=http.createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-jwt');
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET')res.end(JSON.stringify({id,status:'awaiting-browser',expiresAt:Date.now()+60000,authorizationUrl:`https://auth.example.test/a?state=alpha-state&redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/callback`)}`}));
    else {let body='';req.on('data',chunk=>body+=String(chunk));req.on('end',()=>{received.push(JSON.parse(body).callbackUrl);res.end(JSON.stringify({id,status:'verifying'}));});}
  });
  const remotePort=await listen(remote);const relay=createOAuthCallbackRelay([{id:'alpha',port:remotePort},{id:'beta',port:remotePort}]);
  try {
    await assert.rejects(relay.register('unknown',id,'Bearer fixture-jwt'));
    await relay.register('alpha',id,'Bearer fixture-jwt');
    await assert.rejects(relay.register('beta',id,'Bearer fixture-jwt'),/busy/);
    assert.equal((await call(callbackPort,'/callback?code=x&state=beta-state')).status,400);
    assert.equal((await call(callbackPort,'/callback?code=x&state=alpha-state','evil.test')).status,400);
    assert.equal(received.length,0);
    const result=await call(callbackPort,'/callback?code=synthetic-code&state=alpha-state');
    assert.equal(result.status,200);assert.match(result.body,/等待远端 MCP/);
    assert.deepEqual(received,[`http://localhost:${callbackPort}/callback?code=synthetic-code&state=alpha-state`]);
  } finally {relay.close();await close(remote);}
});
test('an occupied callback port is left untouched and the flow can fall back to manual entry',async()=>{
  const occupied=http.createServer((_req,res)=>res.end('original listener'));const callbackPort=await listen(occupied);
  const remote=http.createServer((_req,res)=>res.end(JSON.stringify({id:'test',status:'awaiting-browser',expiresAt:Date.now()+60000,authorizationUrl:`https://auth.example.test/a?state=state&redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/callback`)}`})));
  const remotePort=await listen(remote);const relay=createOAuthCallbackRelay([{id:'alpha',port:remotePort}]);
  try {await assert.rejects(relay.register('alpha','test','Bearer fixture-jwt'),/manual callback/);assert.equal((await call(callbackPort,'/')).body,'original listener');}
  finally {relay.close();await close(remote);await close(occupied);}
});
test('concurrent registration waits for both loopback listeners before either caller is ready', async (t) => {
  const callbackPort = await freePort();
  const remote = http.createServer((_req,res)=>res.end(JSON.stringify({id:'concurrent',status:'awaiting-browser',expiresAt:Date.now()+60000,authorizationUrl:`https://auth.example.test/a?state=state&redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/callback`)}`})));
  const remotePort = await listen(remote); const relay = createOAuthCallbackRelay([{id:'alpha',port:remotePort}]);
  const original = http.Server.prototype.listen; let resume: (()=>void) | undefined;
  t.mock.method(http.Server.prototype, 'listen', function(this:http.Server, ...args: Parameters<typeof original>) {
    const options = args[0] as unknown as {host?:string;port?:number};
    if (options?.host === '::1' && options.port === callbackPort) { resume = () => { original.apply(this,args); }; return this; }
    return original.apply(this,args);
  });
  try {
    let firstReady = false; let secondReady = false;
    const first = relay.register('alpha','concurrent','Bearer fixture-jwt').then(value=>{firstReady=true;return value;});
    while (!resume) await new Promise(resolve=>setTimeout(resolve,1));
    const second = relay.register('alpha','concurrent','Bearer fixture-jwt').then(value=>{secondReady=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal(firstReady,false); assert.equal(secondReady,false);
    resume(); assert.deepEqual(await Promise.all([first,second]),[{ready:true},{ready:true}]);
    await relay.cancel('alpha','concurrent','Bearer fixture-jwt');
    await assert.rejects(call(callbackPort,'/callback?code=fixture&state=state'));
  } finally { relay.close();t.mock.restoreAll(); await close(remote); }
});
test('closing the relay during remote lookup cannot leave a late callback listener',async()=>{
  const callbackPort=await freePort();let respond:(()=>void)|undefined;
  const remote=http.createServer((_req,res)=>{respond=()=>res.end(JSON.stringify({id:'late',status:'awaiting-browser',expiresAt:Date.now()+60000,authorizationUrl:`https://auth.example.test/a?state=state&redirect_uri=${encodeURIComponent(`http://localhost:${callbackPort}/callback`)}`}));});
  const remotePort=await listen(remote);const relay=createOAuthCallbackRelay([{id:'alpha',port:remotePort}]);
  try {
    const registration=relay.register('alpha','late','Bearer fixture-jwt');
    while(!respond)await new Promise(resolve=>setTimeout(resolve,1));
    relay.close();respond();await assert.rejects(registration,/closed/);
    await assert.rejects(call(callbackPort,'/callback?code=fixture&state=state'));
  }finally{relay.close();await close(remote);}
});
