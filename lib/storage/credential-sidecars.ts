import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getApiRoutesPath } from "../api-route-store.js";
import { withRetry } from "../fs-retry.js";
import { getCodexMultiAuthDir } from "../runtime-paths.js";
import { withFileTransactionLock } from "./file-lock.js";
import { withStorageLock } from "./transactions.js";

const retry = { maxAttempts: 6, backoffMs: 25 };

/**
 * Remove the files beside the account pool that hold raw API keys or
 * per-account runtime state. `clearAccounts` only touches the account pool, so
 * `uninstall --clear-accounts` and the dashboard reset call this as well.
 */
export async function clearCredentialSidecars(): Promise<void> {
	const routes = getApiRoutesPath();
	// Same locks as saveApiRoutes, so a concurrent menu save cannot resurrect keys.
	await withStorageLock(() =>
		withFileTransactionLock(routes, () =>
			withRetry(() => fs.rm(routes, { force: true }), retry),
		),
	);
	const dir = getCodexMultiAuthDir();
	for (const path of [
		join(dir, "reset-credits.json"),
		join(dir, "api-capability-probes.json"),
		join(dir, "inference-activity"),
	]) {
		await withRetry(() => fs.rm(path, { recursive: true, force: true }), retry);
	}
}
