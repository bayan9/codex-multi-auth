import { AccountManager } from '../../accounts.js';
import { loadAccounts, setStoragePath } from '../../storage.js';
import { createResetCreditService, resetTargetForStoredAccount } from '../../runtime/account-reset-credits.js';
import { withCheckProgress } from '../../ui/check-progress.js';
const usage='Usage: codex-multi-auth resets list [--refresh] | redeem <account-number> | auto manual|last-resort';
export async function runResetsCommand(args:string[]):Promise<number>{
 const [command='list',value,...extra]=args;
 if(command==='--help'||command==='-h'){console.log(usage);return 0;}
 if(extra.length||!['list','redeem','auto'].includes(command)||(command==='list'&&value!==undefined&&value!=='--refresh')||(command==='redeem'&&!/^[1-9][0-9]*$/.test(value??''))||(command==='auto'&&value!=='manual'&&value!=='last-resort')){console.error(usage);return 1;}
 setStoragePath(null);
 const storage=await loadAccounts();const manager=new AccountManager(undefined,storage);const service=createResetCreditService(manager);
 try{
  if(command==='auto'){await service.setPolicy(value as 'manual'|'last-resort');console.log(`Automatic reset redemption: ${value}`);return 0;}
  if(command==='redeem'){
   const index=Number(value)-1;const account=storage?.accounts[index];const target=account&&resetTargetForStoredAccount(account);if(!target){console.error('Choose a configured, enabled subscription account/workspace.');return 1;}
   const outcome=await withCheckProgress(`Redeeming a reset for account ${index+1}`,()=>service.redeem(target));console.log(`Account ${index+1}: ${outcome}. Usage was re-read.`);return 0;
  }
  const targets=(storage?.accounts??[]).map(resetTargetForStoredAccount).filter(t=>t!==null);
  const refreshed=value==='--refresh'?await withCheckProgress('Refreshing reset-credit availability',()=>service.refresh(targets)):null;
  const state=await service.status();console.log(`Automatic redemption: ${state.policy}`);
  if(state.lastRedemption){const index=(storage?.accounts??[]).findIndex(a=>resetTargetForStoredAccount(a)?.key===state.lastRedemption?.key);console.log(`Last confirmed reset: ${index>=0?`account ${index+1}`:"removed account"}; ${state.lastRedemption.outcome}; ${state.lastRedemption.automatic?"automatic":"explicit"}`);}
  (storage?.accounts??[]).forEach((a,i)=>{const target=resetTargetForStoredAccount(a);const snapshot=target?(refreshed??state.snapshots)[target.key]:undefined;console.log(`Account ${i+1}: ${snapshot?.availableCount??'unknown'} reset credits${snapshot?` (checked ${Math.max(0,Math.floor((Date.now()-snapshot.updatedAt)/1000))}s ago)`:''}${target?.key===state.pending?.key?' [redemption pending; retry this account]':''}`);});return 0;
 }catch{console.error('Reset operation could not be confirmed. No new automatic redemption will be attempted while a result is pending; use resets list and retry the same account.');return 1;}
 finally{await manager.flushPendingSave();}
}
