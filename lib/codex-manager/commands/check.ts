export interface CheckCommandDeps {
 runHealthCheck: (options: { liveProbe: boolean; discoverModels: boolean }) => Promise<void>;
 runResetCheck: () => Promise<number>;
 runCapabilityCheck: () => Promise<boolean>;
 getStoragePath: () => string | null;
 setStoragePath: (path: string | null) => void;
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
 const previous = deps.getStoragePath();
 deps.setStoragePath(null);
 try {
  if (scope === "resets") return await deps.runResetCheck();
  if (scope === "capabilities") return await deps.runCapabilityCheck() ? 0 : 1;
  else await deps.runHealthCheck({ liveProbe: true, discoverModels: scope === undefined });
  return 0;
 } finally {
  deps.setStoragePath(previous);
 }
}
