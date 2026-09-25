import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { nativeRateLimitsRpc } from '../lib/runtime/native-rate-limits.js';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'native-limits-test-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true,maxRetries:5});});
async function fixture(mode='ok'){
 const path=join(dir,'server.mjs');await writeFile(path,`import {createInterface} from 'node:readline';import {readFileSync,writeFileSync} from 'node:fs';const auth=JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json'));writeFileSync(${JSON.stringify(join(dir,'seen.json'))},JSON.stringify({home:process.env.CODEX_HOME,account:auth.tokens.account_id,refresh:auth.tokens.refresh_token}));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));return;}if(${JSON.stringify(mode)}==='hang')return;if(${JSON.stringify(mode)}==='oversize'){console.log('x'.repeat(1100000));return;}console.log(JSON.stringify({id:m.id,${mode==='error'?'error:{message:"private-secret"}':'result:{method:m.method,params:m.params}'} }));});`);return path;
}
const auth={accessToken:'access',accountId:'workspace',expiresAt:Date.now()+3600000};
it('isolates credentials and sends only the requested RPC, then removes temporary home',async()=>{
 const script=await fixture();const result=await nativeRateLimitsRpc(auth,'account/rateLimits/read',{excludeResetCreditDetails:true},{command:[process.execPath,script],tempRoot:dir});expect(result).toEqual({method:'account/rateLimits/read',params:{excludeResetCreditDetails:true}});const seen=JSON.parse(await readFile(join(dir,'seen.json'),'utf8'));expect(seen.account).toBe('workspace');expect(seen.refresh).toBe('');expect((await readdir(dir)).filter(p=>p.startsWith('reset-rpc-'))).toEqual([]);
});
it.each(['hang','oversize','error'])('fails safely and cleans up on %s',async mode=>{
 const script=await fixture(mode);await expect(nativeRateLimitsRpc(auth,'account/rateLimits/read',{}, {command:[process.execPath,script],tempRoot:dir,timeoutMs:300})).rejects.toThrow(/Native usage/);expect((await readdir(dir)).filter(p=>p.startsWith('reset-rpc-'))).toEqual([]);
});
it('does not invoke a process for an expired token or unsupported operation',async()=>{
 await expect(nativeRateLimitsRpc({...auth,expiresAt:0},'account/rateLimits/read',{}, {tempRoot:dir})).rejects.toThrow(/fresh/);
});
