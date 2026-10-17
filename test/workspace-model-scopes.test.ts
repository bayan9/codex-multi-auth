import {describe,it,expect} from "vitest";
import type {ManagedAccount} from "../lib/accounts.js";
import {workspaceModelScopes} from "../lib/runtime/workspace-model-scopes.js";
const account = (changes:Partial<ManagedAccount>={}) => ({index:0,accountId:"bound",access:"",refreshToken:"test",workspaces:[{id:"first",enabled:true},{id:"chosen",enabled:true}],currentWorkspaceIndex:1,...changes} as ManagedAccount);
describe("workspace routing boundaries",()=>{
 it("routes only the chosen workspace, excluding siblings and stored binding",()=>{
  expect(workspaceModelScopes(account()).filter(s=>s.routable).map(s=>s.accountId)).toEqual(["chosen"]);
 });
 it("does not replace a disabled selected workspace",()=>{
  expect(workspaceModelScopes(account({workspaces:[{id:"first",enabled:true},{id:"chosen",enabled:false}]})).filter(s=>s.routable)).toEqual([]);
 });
 it("fails closed for an invalid selection",()=>{
  expect(workspaceModelScopes(account({currentWorkspaceIndex:9})).filter(s=>s.routable)).toEqual([]);
 });
 it("preserves bound routing for accounts without tracked workspaces",()=>{
  expect(workspaceModelScopes(account({workspaces:[]})).filter(s=>s.routable).map(s=>s.accountId)).toEqual(["bound"]);
 });
});
