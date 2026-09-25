import type { AccountManager } from "../accounts.js";
import { sanitizeEmail } from "../auth/token-utils.js";
import type { AccountStorageV3 } from "../storage.js";

type Identity = { recordId?: string; accountId?: string; email?: string };
/**
 * The manager stores sanitized (lower-cased) emails while storage keeps the raw
 * value, so match a stored record ID first and otherwise the canonical identity.
 */
export function isSameNativeAccount(account: Identity, disk: Identity | undefined): boolean {
	if (!disk) return false;
	const left = account.recordId?.trim();
	const right = disk.recordId?.trim();
	if (left && right) return left === right;
	return account.accountId === disk.accountId && sanitizeEmail(account.email) === sanitizeEmail(disk.email);
}

/** Adopt credentials from a re-login without resetting independent quota state. */
export function syncNativeAccountCredentials(
	manager: AccountManager,
	storage: AccountStorageV3,
): boolean {
	let changed = manager.syncWorkspaceSelections(storage);
	for (const snapshot of manager.getAccountsSnapshot()) {
		const account = manager.getAccountByIndex(snapshot.index);
		if (!account) continue;
		const disk = storage.accounts.find((a) => isSameNativeAccount(account, a));
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
