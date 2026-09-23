import { describe, it, expect } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { syncNativeAccountCredentials } from "../lib/runtime/native-account-sync.js";
const fixture = (): AccountStorageV3 => ({
	version: 3,
	activeIndex: 0,
	accounts: [
		{
			email: "a@example.test",
			accountId: "a",
			refreshToken: "old-refresh",
			accessToken: "old-access",
			expiresAt: 2000,
			addedAt: 1,
			lastUsed: 1,
			coolingDownUntil: 9999,
			cooldownReason: "auth-failure",
			rateLimitResetTimes: { codex: 99999 },
		},
	],
});
describe("native account credential reload", () => {
	it("adopts fresh login credentials and clears only obsolete auth cooldown", () => {
		const storage = fixture(),
			manager = new AccountManager(undefined, storage);
		const disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, {
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresAt: 3000,
		});
		expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
		const account = manager.getAccountByIndex(0)!;
		expect(account.access).toBe("new-access");
		expect(account.cooldownReason).toBeUndefined();
		expect(account.rateLimitResetTimes.codex).toBe(99999);
	});
	it("keeps cooldown for unchanged credentials and never downgrades a newer token", () => {
		const storage = fixture(),
			manager = new AccountManager(undefined, storage);
		expect(syncNativeAccountCredentials(manager, storage)).toBe(false);
		expect(manager.getAccountByIndex(0)!.cooldownReason).toBe("auth-failure");
		const disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, { accessToken: "older", expiresAt: 1000 });
		expect(syncNativeAccountCredentials(manager, disk)).toBe(false);
		expect(manager.getAccountByIndex(0)!.access).toBe("old-access");
	});
	it("applies disablement without clearing quota cooldowns on token changes", () => {
		const storage = fixture();
		storage.accounts[0]!.cooldownReason = "network-error";
		const manager = new AccountManager(undefined, storage),
			disk = structuredClone(storage);
		Object.assign(disk.accounts[0]!, {
			enabled: false,
			accessToken: "new",
			expiresAt: 3000,
		});
		syncNativeAccountCredentials(manager, disk);
		expect(manager.getAccountByIndex(0)!.enabled).toBe(false);
		expect(manager.getAccountByIndex(0)!.cooldownReason).toBe("network-error");
	});
});

it("adopts explicit invalidation even when credentials have not changed", () => {
	const storage = fixture(),
		manager = new AccountManager(undefined, storage),
		disk = structuredClone(storage);
	disk.accounts[0]!.authInvalidatedAt = 1500;
	disk.accounts[0]!.authInvalidationErrorCode = "token_revoked";
	expect(syncNativeAccountCredentials(manager, disk)).toBe(true);
	expect(manager.getAccountByIndex(0)!.authInvalidatedAt).toBe(1500);
});
