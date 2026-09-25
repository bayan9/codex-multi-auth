import type { AccountManager } from "../accounts.js";
import type { AccountStorageV3 } from "../storage.js";

/** Adopt credentials from a re-login without resetting independent quota state. */
export function syncNativeAccountCredentials(
	manager: AccountManager,
	storage: AccountStorageV3,
): boolean {
	let changed = manager.syncWorkspaceSelections(storage);
	for (const snapshot of manager.getAccountsSnapshot()) {
		const account = manager.getAccountByIndex(snapshot.index);
		if (!account) continue;
		const disk = storage.accounts.find(
			(a) => a.accountId === account.accountId && a.email === account.email,
		);
		if (!disk) {
			account.enabled = false;
			changed = true;
			continue;
		}
		if ((account.enabled !== false) !== (disk.enabled !== false)) {
			account.enabled = disk.enabled;
			changed = true;
		}
		if (
			disk.authInvalidatedAt &&
			disk.authInvalidatedAt !== account.authInvalidatedAt
		) {
			account.authInvalidatedAt = disk.authInvalidatedAt;
			account.authInvalidationErrorCode = disk.authInvalidationErrorCode;
			changed = true;
		}
		if (
			disk.accessToken === account.access &&
			disk.refreshToken === account.refreshToken &&
			disk.expiresAt === account.expires
		)
			continue;
		account.access = disk.accessToken;
		account.refreshToken = disk.refreshToken;
		account.expires = disk.expiresAt;
		if (disk.accessToken && disk.refreshToken && !disk.authInvalidatedAt) {
			delete account.authInvalidatedAt;
			delete account.authInvalidationErrorCode;
			if (account.cooldownReason === "auth-failure")
				manager.clearAccountCooldown(account);
		}
		changed = true;
	}
	return changed;
}
