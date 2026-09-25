import { runWithGlobalStoragePath } from "../../storage/path-state.js";

export interface CheckCommandDeps {
 runHealthCheck: (options: { liveProbe: boolean; discoverModels: boolean }) => Promise<void>;
 runResetCheck: () => Promise<number>;
 runCapabilityCheck: () => Promise<boolean>;
 logInfo?: (message: string) => void;
 logError?: (message: string) => void;
}
const usage = "Usage: codex-multi-auth check [accounts|resets|capabilities]";
export async function runCheckCommand(deps: CheckCommandDeps, args: string[] = []): Promise<number> {
 const [scope] = args;
 if (args.length === 1 && (scope === "--help" || scope === "-h")) {
  (deps.logInfo ?? console.log)(usage);
  return 0;
 }
 if (args.length > 1 || (scope !== undefined && !["accounts", "resets", "capabilities"].includes(scope))) {
  (deps.logError ?? console.error)(usage);
  return 1;
 }
 return runWithGlobalStoragePath(async () => {
  if (scope === "resets") return await deps.runResetCheck();
  if (scope === "capabilities") return await deps.runCapabilityCheck() ? 0 : 1;
  else await deps.runHealthCheck({ liveProbe: true, discoverModels: scope === undefined });
  return 0;
 });
}
