import {expect,it} from "vitest";
import {promises as fs} from "node:fs";
import {join} from "node:path";
import {getCodexMultiAuthDir} from "../lib/runtime-paths.js";
import {saveInferenceRequestTime,loadInferenceRequestTimes} from "../lib/runtime/inference-activity.js";
it("retains inference times when another process overwrites diagnostic telemetry",async()=>{
 const key=`sha256:${"a".repeat(64)}`;
 await saveInferenceRequestTime(key,2000);
 await fs.writeFile(join(getCodexMultiAuthDir(),"runtime-observability.json"),JSON.stringify({lastInferenceRequestAtByAccount:{[key]:100}}));
 expect((await loadInferenceRequestTimes([key]))[key]).toBe(2000);
 await saveInferenceRequestTime(key,1000);
 expect((await loadInferenceRequestTimes([key]))[key]).toBe(2000);
 const path=join(getCodexMultiAuthDir(),"inference-activity",`${"a".repeat(64)}.json`);
 if(process.platform!=="win32") expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
});
it("rejects unsafe keys and malformed timestamp files",async()=>{
 await saveInferenceRequestTime("../../outside",100);
 expect(await loadInferenceRequestTimes(["../../outside"])).toEqual({});
 const key=`sha256:${"b".repeat(64)}`;
 await saveInferenceRequestTime(key,3000);
 await fs.writeFile(join(getCodexMultiAuthDir(),"inference-activity",`${"b".repeat(64)}.json`),"x".repeat(1000));
 expect(await loadInferenceRequestTimes([key])).toEqual({});
});

it("keeps distinct logins separate even when they share a workspace account ID",async()=>{
 const {inferenceAccountKey}=await import("../lib/runtime/inference-activity.js");
 expect(inferenceAccountKey({accountId:"shared",email:"one@example.com"})).not.toBe(inferenceAccountKey({accountId:"shared",email:"two@example.com"}));
 expect(inferenceAccountKey({accountId:"shared",email:"ONE@example.com"})).toBe(inferenceAccountKey({accountId:"shared",email:"one@example.com"}));
});
