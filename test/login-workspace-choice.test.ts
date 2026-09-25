import {describe,it,expect,vi} from 'vitest';
import {chooseLoginWorkspace} from '../lib/codex-manager/login-workspace-choice.js';
const team={accountId:'team',label:'Business',source:'org' as const,isDefault:true};
const personal={accountId:'personal',label:'Personal (role:owner) [id:fixture]',source:'org' as const};
describe('new login workspace choice',()=>{
 it('defaults to the unique Personal workspace without prompting',async()=>{
  const select=vi.fn();
  expect(await chooseLoginWorkspace([team,personal],{interactive:false,select})).toBeUndefined();
  expect(select).not.toHaveBeenCalled();
 });
 it('requires a choice when multiple workspaces have no identifiable Personal',async()=>{
  const select=vi.fn().mockResolvedValue('second');
  expect(await chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:true,select})).toBe('second');
  expect(select).toHaveBeenCalledOnce();
 });
 it('does not silently select a default in a noninteractive login',async()=>{
  await expect(chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:false,select:vi.fn()})).rejects.toThrow('login --org');
 });
 it('returns cancellation without a workspace choice',async()=>{
  expect(await chooseLoginWorkspace([team,{...personal,isPersonal:false}],{interactive:true,select:vi.fn().mockResolvedValue(null)})).toBeNull();
 });
 it('asks when multiple candidates are marked Personal',async()=>{
  const select=vi.fn().mockResolvedValue('other');
  expect(await chooseLoginWorkspace([personal,{...personal,accountId:'other'}],{interactive:true,select})).toBe('other');
  expect(select).toHaveBeenCalledOnce();
 });
 it('rejects a selection not offered by the account',async()=>{
  await expect(chooseLoginWorkspace([team,{...team,accountId:'second'}],{interactive:true,select:vi.fn().mockResolvedValue('unrelated')})).rejects.toThrow('Invalid workspace');
 });
 it('does not prompt for a token-only account',async()=>{
  expect(await chooseLoginWorkspace([{...team,source:'token'}],{interactive:false,select:vi.fn()})).toBeUndefined();
 });
});
