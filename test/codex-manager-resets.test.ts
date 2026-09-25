import { beforeEach, expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({list:vi.fn(),redeem:vi.fn(),policy:vi.fn(),refresh:vi.fn()}));
vi.mock('../lib/runtime/account-reset-credits.js',async original=>({...await original<typeof import('../lib/runtime/account-reset-credits.js')>(),createResetCreditService:()=>({status:f.list,redeem:f.redeem,setPolicy:f.policy,refresh:f.refresh})}));
vi.mock('../lib/storage.js',async original=>({...await original<typeof import('../lib/storage.js')>(),loadAccounts:async()=>({version:3,activeIndex:0,accounts:[{accountId:'workspace',refreshToken:'secret',addedAt:1,lastUsed:1}]})}));
import { runResetsCommand } from '../lib/codex-manager/commands/resets.js';
beforeEach(()=>{vi.clearAllMocks();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'error').mockImplementation(()=>{});f.list.mockResolvedValue({version:1,policy:'manual',snapshots:{}});f.redeem.mockResolvedValue('reset');});
it('lists without provider reads or redemption by default',async()=>{expect(await runResetsCommand([])).toBe(0);expect(f.refresh).not.toHaveBeenCalled();expect(f.redeem).not.toHaveBeenCalled();});
it('requires an explicit valid account to redeem',async()=>{for(const args of [['redeem'],['redeem','0'],['redeem','2'],['redeem','1','extra']])expect(await runResetsCommand(args)).toBe(1);expect(f.redeem).not.toHaveBeenCalled();expect(await runResetsCommand(['redeem','1'])).toBe(0);expect(f.redeem).toHaveBeenCalledTimes(1);});
it('changes policy only by explicit command',async()=>{expect(await runResetsCommand(['auto','last-resort'])).toBe(0);expect(f.policy).toHaveBeenCalledWith('last-resort');expect(f.redeem).not.toHaveBeenCalled();});
it('does not retry an ambiguous redemption or print secret backend errors',async()=>{f.redeem.mockRejectedValue(Error('secret'));expect(await runResetsCommand(['redeem','1'])).toBe(1);expect(f.redeem).toHaveBeenCalledTimes(1);expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('secret');});
it('routes the standalone resets command through the CLI dispatcher',async()=>{
 const {runCodexMultiAuthCli}=await import('../lib/codex-manager.js');expect(await runCodexMultiAuthCli(['resets','--help'])).toBe(0);expect(f.redeem).not.toHaveBeenCalled();
});
