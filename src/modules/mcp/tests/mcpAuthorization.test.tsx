import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { McpAuthorizationModal } from '@/modules/mcp/modals/McpAuthorizationModal';
import { mcpAuthApi } from '@/shared/api';
import type { McpAuthAttempt, ProviderMcpServer } from '@/shared/types';

vi.mock('@/shared/api',()=>({mcpAuthApi:{start:vi.fn(),read:vi.fn(),callback:vi.fn(),cancel:vi.fn(),prepareLocalCallback:vi.fn()}}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(_key:string,values?:{defaultValue?:string})=>values?.defaultValue || _key})}));
const server:ProviderMcpServer={name:'notion-fixture',provider:'claude',scope:'user',transport:'http'};
const waiting:McpAuthAttempt={id:'fixture-attempt',name:server.name,scope:'user',expiresAt:Date.now()+60000,status:'awaiting-browser',authorizationUrl:'https://auth.example.test/authorize?state=fixture',error:null};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(mcpAuthApi.start).mockResolvedValue(waiting);vi.mocked(mcpAuthApi.read).mockResolvedValue(waiting);vi.mocked(mcpAuthApi.cancel).mockResolvedValue({...waiting,status:'cancelled'});vi.mocked(mcpAuthApi.prepareLocalCallback).mockRejectedValue(new Error('Fixture port unavailable'));});
test('StrictMode starts one remote flow and a refused callback keeps manual entry available',async()=>{
  const view=render(<StrictMode><McpAuthorizationModal server={server} onClose={()=>{}}/></StrictMode>);
  await screen.findByRole('link',{name:'Open authorization page'});
  await waitFor(()=>expect(mcpAuthApi.prepareLocalCallback).toHaveBeenCalledTimes(1));
  expect(mcpAuthApi.start).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Full callback URL')).toBeTruthy();
  expect(screen.queryByText('Connected — confirmed by the remote MCP health check.')).toBeNull();
  view.unmount();await act(async()=>{});expect(mcpAuthApi.cancel).toHaveBeenCalledWith(waiting.id);
});
test('pasting a callback waits for remote connection evidence, not the authorization page',async()=>{
  vi.mocked(mcpAuthApi.callback).mockResolvedValue({...waiting,status:'verifying'});
  const view=render(<McpAuthorizationModal server={server} onClose={()=>{}}/>);
  const input=await screen.findByLabelText('Full callback URL');
  fireEvent.change(input,{target:{value:'http://localhost:63649/callback?code=synthetic&state=fixture'}});
  fireEvent.click(screen.getByRole('button',{name:'Send to this remote'}));
  await screen.findByText('Checking the remote MCP connection…');
  expect(screen.queryByText('Connected — confirmed by the remote MCP health check.')).toBeNull();
  view.unmount();
});
test('retry and unmount release a finished attempt as well as a pending local callback lease',async()=>{
  vi.mocked(mcpAuthApi.start).mockResolvedValueOnce({...waiting,status:'failed',authorizationUrl:null,error:'Fixture failure'}).mockResolvedValueOnce({...waiting,id:'next-attempt'});
  const view=render(<McpAuthorizationModal server={server} onClose={()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Start a new authorization'}));
  await screen.findByLabelText('Full callback URL');
  expect(mcpAuthApi.cancel).toHaveBeenCalledWith(waiting.id);
  view.unmount();await act(async()=>{});expect(mcpAuthApi.cancel).toHaveBeenCalledWith('next-attempt');
});
test('a callback reservation that completes after unmount is released again',async()=>{
  let finish!:()=>void;
  vi.mocked(mcpAuthApi.prepareLocalCallback).mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve({ready:true});}));
  const view=render(<McpAuthorizationModal server={server} onClose={()=>{}}/>);
  await waitFor(()=>expect(mcpAuthApi.prepareLocalCallback).toHaveBeenCalled());
  view.unmount();vi.mocked(mcpAuthApi.cancel).mockClear();
  await act(async()=>finish());
  expect(mcpAuthApi.cancel).toHaveBeenCalledWith(waiting.id);
});
