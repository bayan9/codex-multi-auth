import { expect,it } from 'vitest';
import { resetTargetForStoredAccount } from '../lib/runtime/account-reset-credits.js';
it('uses the native credential binding, not an organization display alias',()=>{
 const account={recordId:'r',accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',name:'Token account'},{id:'org-personal',name:'Personal'}],currentWorkspaceIndex:1};
 expect(resetTargetForStoredAccount(account)?.accountId).toBe('native-workspace');expect(account.currentWorkspaceIndex).toBe(1);
});
it('does not redeem a disabled native workspace or an organization ID',()=>{
 const account={accountId:'native-workspace',refreshToken:'secret',addedAt:1,lastUsed:1,workspaces:[{id:'native-workspace',enabled:false}]};expect(resetTargetForStoredAccount(account)).toBeNull();expect(resetTargetForStoredAccount({...account,accountId:'org-fixture'})).toBeNull();
});
it('resolves an organization-only binding from the native token claim without changing preferences',()=>{
 const token='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'native-workspace'}})).toString('base64url')+'.signature';
 const account={recordId:'r',accountId:'org-personal',accessToken:token,refreshToken:'secret',addedAt:1,lastUsed:1,currentWorkspaceIndex:1,workspaces:[{id:'native-workspace'},{id:'org-personal',name:'Personal'}]};
 expect(resetTargetForStoredAccount(account)?.accountId).toBe('native-workspace');expect(account.accountId).toBe('org-personal');expect(account.currentWorkspaceIndex).toBe(1);
});
it('revalidates the current native target against persisted enablement',async()=>{
 const {isResetTargetEnabled}=await import('../lib/runtime/account-reset-credits.js');
 const account={recordId:'r',accountId:'native',refreshToken:'secret',addedAt:1,lastUsed:1};const target=resetTargetForStoredAccount(account)!;
 expect(isResetTargetEnabled(account,target)).toBe(true);expect(isResetTargetEnabled({...account,enabled:false},target)).toBe(false);expect(isResetTargetEnabled({...account,accountId:'other'},target)).toBe(false);
});
