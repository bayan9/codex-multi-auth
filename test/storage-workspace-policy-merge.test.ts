import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { runWorkspaceCommand } from "../lib/codex-manager/commands/workspace.js";
import {
	loadAccounts,
	saveAccounts,
	setStoragePathDirect,
	type AccountStorageV3,
} from "../lib/storage.js";
import { removeWithRetry } from "./helpers/remove-with-retry.js";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "workspace-policy-merge-"));
	setStoragePathDirect(join(directory, "accounts.json"));
	await saveAccounts({
		version: 3,
		activeIndex: 0,
		accounts: [{
			recordId: "workspace-policy-fixture",
			accountId: "workspace-selected",
			refreshToken: "workspace-policy-fixture-token",
			addedAt: 1,
			lastUsed: 1,
			workspaces: [
				{ id: "workspace-selected", enabled: true },
				{ id: "workspace-sibling", enabled: true },
			],
			currentWorkspaceIndex: 0,
		}],
	});
});

afterEach(async () => {
	setStoragePathDirect(null);
	await removeWithRetry(directory, { recursive: true, force: true });
});

async function setWorkspaceEnabled(storage: AccountStorageV3, enabled: boolean) {
	expect(await runWorkspaceCommand(["1", "1", enabled ? "enable" : "disable"], {
		setStoragePath: () => {},
		loadAccounts: async () => storage,
		saveAccounts,
		logError: vi.fn(),
		logInfo: vi.fn(),
	})).toBe(0);
}

it.each(["operator-first", "runtime-first"])(
	"preserves an operator exclusion across a concurrent runtime disable (%s)",
	async (order) => {
		const operator = (await loadAccounts())!;
		const runtime = (await loadAccounts())!;
		Object.assign(runtime.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 10 });

		if (order === "operator-first") {
			await setWorkspaceEnabled(operator, false);
			await saveAccounts(runtime);
		} else {
			await saveAccounts(runtime);
			await setWorkspaceEnabled(operator, false);
		}

		const merged = (await loadAccounts())!;
		expect(merged.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: false });
		expect(merged.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);

		const toggled = new AccountManager(undefined, merged);
		toggled.setAccountEnabled(0, false);
		toggled.setAccountEnabled(0, true);
		await toggled.saveToDisk();
		const afterToggle = (await loadAccounts())!;
		expect(afterToggle.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: false });
		expect(afterToggle.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);

		await setWorkspaceEnabled(afterToggle, true);
		const enabled = (await loadAccounts())!;
		expect(enabled.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: true });
		expect(enabled.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);
	},
);

it.each(["operator-first", "runtime-first"])(
	"preserves an explicit re-enable across a concurrent runtime health update (%s)",
	async (order) => {
		const initial = (await loadAccounts())!;
		Object.assign(initial.accounts[0]!.workspaces![0]!, { enabled: false, disabledAt: 10 });
		await saveAccounts(initial);
		const operator = (await loadAccounts())!;
		const runtime = (await loadAccounts())!;
		runtime.accounts[0]!.workspaces![0]!.disabledAt = 20;
		if (order === "operator-first") {
			await setWorkspaceEnabled(operator, true);
			await saveAccounts(runtime);
		} else {
			await saveAccounts(runtime);
			await setWorkspaceEnabled(operator, true);
		}
		const merged = (await loadAccounts())!;
		expect(merged.accounts[0]!.workspaces![0]).toEqual({ id: "workspace-selected", enabled: true });
		expect(merged.accounts[0]!.currentWorkspaceIndex ?? 0).toBe(0);
	},
);
