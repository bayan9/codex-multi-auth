import { describe, expect, it, vi } from "vitest";
import { type CheckCommandDeps, runCheckCommand } from "../lib/codex-manager/commands/check.js";
function setup() {
 let scope: string | null = "C:\\projects\\fixture";
 const deps = {
  runHealthCheck: vi.fn(async () => undefined),
  runResetCheck: vi.fn(async () => 0),
  runCapabilityCheck: vi.fn(async () => true),
  getStoragePath: () => scope,
  setStoragePath: vi.fn((next: string | null) => { scope = next; }),
  logInfo: vi.fn(), logError: vi.fn(),
 } satisfies CheckCommandDeps;
 return deps;
}
describe("focused check commands", () => {
 it.each([[], ["accounts"], ["resets"], ["capabilities"]])("runs only the requested checks: %j", async (...args) => {
  const deps = setup(), original = deps.getStoragePath();
  expect(await runCheckCommand(deps, args)).toBe(0);
  expect(deps.runHealthCheck).toHaveBeenCalledTimes(args.length === 0 || args[0] === "accounts" ? 1 : 0);
  if (args.length === 0 || args[0] === "accounts") expect(deps.runHealthCheck).toHaveBeenCalledWith({ liveProbe: true, discoverModels: args.length === 0 });
  expect(deps.runResetCheck).toHaveBeenCalledTimes(args[0] === "resets" ? 1 : 0);
  expect(deps.runCapabilityCheck).toHaveBeenCalledTimes(args[0] === "capabilities" ? 1 : 0);
  expect(deps.setStoragePath).toHaveBeenNthCalledWith(1, null);
  expect(deps.getStoragePath()).toBe(original);
 });
 it.each([["unknown"], ["accounts", "extra"], ["--help", "extra"]])("rejects invalid arguments without network calls: %j", async (...args) => {
  const deps = setup();
  expect(await runCheckCommand(deps, args)).toBe(1);
  expect(deps.runHealthCheck).not.toHaveBeenCalled();
  expect(deps.runResetCheck).not.toHaveBeenCalled();
  expect(deps.runCapabilityCheck).not.toHaveBeenCalled();
  expect(deps.setStoragePath).not.toHaveBeenCalled();
 });
 it("prints help without checking accounts", async () => {
  const deps = setup(); expect(await runCheckCommand(deps, ["--help"])).toBe(0);
  expect(deps.logInfo).toHaveBeenCalledWith(expect.stringContaining("accounts|resets|capabilities"));
  expect(deps.runHealthCheck).not.toHaveBeenCalled();
 });
 it("preserves reset-check failure status", async () => {
  const deps = setup(); deps.runResetCheck.mockResolvedValue(1);
  expect(await runCheckCommand(deps, ["resets"])).toBe(1);
 });
 it.each([[], ["accounts"], ["resets"], ["capabilities"]])("restores storage scope after a failed check: %j", async (...args) => {
  const deps = setup(), original = deps.getStoragePath(), error = Error("probe failed");
  deps.runHealthCheck.mockRejectedValue(error); deps.runResetCheck.mockRejectedValue(error); deps.runCapabilityCheck.mockRejectedValue(error);
  await expect(runCheckCommand(deps, args)).rejects.toThrow("probe failed");
  expect(deps.getStoragePath()).toBe(original);
 });
});

it("returns failure when capability discovery cannot refresh", async () => {
 const deps = setup(); deps.runCapabilityCheck.mockResolvedValue(false);
 expect(await runCheckCommand(deps,["capabilities"])).toBe(1);
});
