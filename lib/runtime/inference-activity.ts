import { createHash } from "node:crypto";
import { getAccountIdentityKey } from "../storage/identity.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { tempPathFor } from "../temp-path.js";
import { withRetry } from "../fs-retry.js";
import { mapWithConcurrency } from "../concurrency.js";

export function inferenceAccountKey(account: Parameters<typeof getAccountIdentityKey>[0]): string {
 return `sha256:${createHash("sha256").update(getAccountIdentityKey(account) ?? "unknown").digest("hex")}`;
}

const validKey = (key: string) => /^sha256:[a-f0-9]{64}$/.test(key);
function activityPath(key: string): string {
 return join(getCodexMultiAuthDir(), "inference-activity", `${key.slice(7)}.json`);
}
async function readTimestamp(key: string): Promise<number | null> {
 try {
  const handle=await fs.open(activityPath(key),"r");
  try {
   const bytes=Buffer.alloc(64);
   const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
   if(bytesRead===bytes.length)return null;
   const value:unknown=JSON.parse(bytes.subarray(0,bytesRead).toString("utf8"));
   return typeof value==="number" && Number.isFinite(value) && value>0 ? value : null;
  } finally {await handle.close();}
 } catch {return null;}
}

/** Separate from shared diagnostic snapshots: only inference dispatches write these files. */
export async function saveInferenceRequestTime(key: string, at: number): Promise<void> {
 if(!validKey(key) || !Number.isFinite(at) || at<=0) return;
 const path=activityPath(key), temp=tempPathFor(path);
 await fs.mkdir(join(getCodexMultiAuthDir(),"inference-activity"),{recursive:true,mode:0o700});
 const timestamp=Math.max(at,await readTimestamp(key) ?? 0);
 try {
  await fs.writeFile(temp,JSON.stringify(timestamp)+"\n",{mode:0o600,flag:"wx"});
  await withRetry(()=>fs.rename(temp,path),{maxAttempts:6,backoffMs:25});
 } finally {
  await withRetry(()=>fs.unlink(temp),{maxAttempts:6,backoffMs:25}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
 }
}
export async function loadInferenceRequestTimes(keys: string[]): Promise<Record<string, number>> {
 const entries=await mapWithConcurrency([...new Set(keys)].filter(validKey).slice(0,1000),4,async key=>({key,at:await readTimestamp(key)}));
 return Object.fromEntries(entries.flatMap(entry=>entry.at===null?[]:[[entry.key,entry.at]]));
}
