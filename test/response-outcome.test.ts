import {expect,it} from "vitest";
import {ResponseOutcome} from "../lib/request/response-outcome.js";
it.each(["failed","incomplete","cancelled"])("rejects non-streaming response status %s",status=>{
 const outcome=new ResponseOutcome(false);outcome.observe({object:"response",status,error:{code:"model_not_found",message:"must not retain"}});
 expect(outcome.finish().success).toBe(false);
 expect(JSON.stringify(outcome)).not.toContain("must not retain");
});
it("accepts a completed empty prewarm and cannot turn a failed event into success",()=>{
 const complete=new ResponseOutcome(true);complete.observe({type:"response.completed",response:{output:[]}});expect(complete.finish().success).toBe(true);
 const failed=new ResponseOutcome(true);failed.observe({type:"error",code:"model_not_found"});failed.observe({type:"response.completed"});expect(failed.finish().success).toBe(false);
 expect(failed.rejection?.error.code).toBe("model_not_found");
});
