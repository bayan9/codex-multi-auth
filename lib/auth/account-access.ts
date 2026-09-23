import { CODEX_BASE_URL } from "../constants.js";
import { logWarn } from "../logger.js";
import type { AccountIdSource } from "../types.js";

/**
 * Which accounts the backend will actually let the current credentials act as.
 *
 * Codex CLI >= 0.156.0 resolves this itself through
 * `GET /backend-api/wham/accounts/check` before every request and refuses to run
 * when the account it was told to use is absent from the answer
 * ("selected workspace missing from routing discovery"). The id/organization
 * lists carried inside the token claims are NOT the same thing: a token can list
 * an organization it has no live authorization for, so selecting a workspace from
 * the claims alone can persist an account id that every later request rejects.
 */
export interface AuthorizedAccounts {
	/** Every account id the response listed, in the order it listed them. */
	accountIds: string[];
	/** The id the backend itself considers the default, when it named one. */
	defaultAccountId?: string;
}

export interface FetchAuthorizedAccountsOptions {
	/** Injection seam for tests; defaults to the global fetch. */
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

const ACCOUNTS_CHECK_PATH = "/wham/accounts/check";
const ACCOUNTS_CHECK_TIMEOUT_MS = 10_000;

function readString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the account ids out of a `wham/accounts/check` payload.
 *
 * Returns null when the payload carries no usable list, which the caller must
 * treat as "unknown" rather than "nothing is authorized" — refusing every
 * account on a shape we failed to parse would break logins for a response format
 * change alone.
 */
export function parseAuthorizedAccounts(
	payload: unknown,
): AuthorizedAccounts | null {
	if (!isRecord(payload)) return null;

	const accounts = payload.accounts;
	if (!Array.isArray(accounts)) return null;

	const accountIds: string[] = [];
	for (const entry of accounts) {
		if (!isRecord(entry)) continue;
		const id = readString(entry.id) ?? readString(entry.account_id);
		if (id && !accountIds.includes(id)) accountIds.push(id);
	}
	if (accountIds.length === 0) return null;

	const defaultAccountId = readString(payload.default_account_id);
	return defaultAccountId ? { accountIds, defaultAccountId } : { accountIds };
}

/**
 * Asks the backend which accounts these credentials may act as.
 *
 * Fails open (resolves null) for every error: this check exists to catch a
 * selection that would not work, so an unreachable or unparseable answer must
 * leave the caller's existing behavior untouched rather than block a login.
 */
export async function fetchAuthorizedAccounts(
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<AuthorizedAccounts | null> {
	const token = readString(accessToken);
	if (!token) return null;

	const doFetch = options.fetch ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(ACCOUNTS_CHECK_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;

	try {
		const response = await doFetch(`${CODEX_BASE_URL}${ACCOUNTS_CHECK_PATH}`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
			},
			signal,
		});
		if (!response.ok) return null;
		return parseAuthorizedAccounts(await response.json());
	} catch {
		// Deliberately silent about the cause: the token is in scope here and the
		// failure is advisory, so there is nothing safe or useful to log.
		return null;
	}
}

export interface ConstrainedSelection {
	/** The account id to actually persist. */
	accountId: string;
	/** True when the backend's answer forced a different id than requested. */
	changed: boolean;
	/** The id that was rejected, present only when `changed` is true. */
	rejected?: string;
}

/**
 * Narrows a chosen account id to one the backend authorizes.
 *
 * Only ever narrows: with no authorization data, no default to fall back to, or
 * an id that is already authorized, the caller's own choice is returned
 * unchanged. That keeps this a guard against a known-bad write rather than a new
 * way for a login to end up somewhere the user did not ask for.
 */
export function constrainSelectionToAuthorized(
	accountId: string,
	authorized: AuthorizedAccounts | null,
): ConstrainedSelection {
	if (!authorized) return { accountId, changed: false };
	if (authorized.accountIds.includes(accountId)) {
		return { accountId, changed: false };
	}
	const fallback = authorized.defaultAccountId;
	if (!fallback || fallback === accountId) {
		return { accountId, changed: false };
	}
	return { accountId: fallback, changed: true, rejected: accountId };
}

/** The slice of a resolved login selection this guard reads and rewrites. */
export interface AccountSelectionLike {
	accountIdOverride?: string;
	accountIdSource?: AccountIdSource;
}

/**
 * Applies {@link constrainSelectionToAuthorized} to a resolved login selection.
 *
 * On a rewrite the source becomes `token`: the backend's default account IS the
 * account these credentials are, so it must auto-follow later token refreshes
 * (see `shouldUpdateAccountIdFromToken`) instead of being pinned the way an
 * explicit org/manual choice is.
 */
export function applyAuthorizedAccountConstraint<T extends AccountSelectionLike>(
	selection: T,
	authorized: AuthorizedAccounts | null,
): { selection: T; result: ConstrainedSelection | null } {
	const current = readString(selection.accountIdOverride);
	if (!current || !authorized) return { selection, result: null };

	const result = constrainSelectionToAuthorized(current, authorized);
	if (!result.changed) return { selection, result };

	return {
		selection: {
			...selection,
			accountIdOverride: result.accountId,
			accountIdSource: "token",
		},
		result,
	};
}

/** The slice of a saved account record this migration reads and rewrites. */
export interface StoredAccountIdentity {
	accountId?: string;
	accountIdSource?: AccountIdSource;
}

/**
 * Rebinds a saved account's id when it is not one the backend currently
 * authorizes, mutating the record in place. This is the migration path for
 * accounts saved before this guard existed (or by `codex-multi-auth workspace
 * <account> <workspace>`, which has no live check of its own).
 *
 * Scoped to `accountIdSource === "org"` — the one source that never
 * auto-follows the token (`shouldUpdateAccountIdFromToken`). "token" /
 * "id_token" already self-correct through `applyTokenAccountIdentity`, and
 * "manual" is an explicit `login --org` binding this must not override.
 */
export async function reboundUnauthorizedAccountIdentity(
	account: StoredAccountIdentity,
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<ConstrainedSelection | null> {
	if (account.accountIdSource !== "org") return null;
	const currentId = readString(account.accountId);
	if (!currentId) return null;

	const authorized = await fetchAuthorizedAccounts(accessToken, options);
	const result = constrainSelectionToAuthorized(currentId, authorized);
	if (!result.changed) return null;

	account.accountId = result.accountId;
	account.accountIdSource = "token";
	return result;
}

/**
 * Fetches authorization and applies it to a resolved selection in one step,
 * warning when it had to override the choice.
 *
 * Call this ONLY for an automatically derived selection. A selection the user
 * named (`login --org`) or a targeted re-authentication of a saved row must keep
 * its id: the former is explicit intent, and the latter is checked against
 * `expectedAccount` by `persistAccountPool`, which would reject a rewritten id
 * as an identity mismatch.
 */
export async function constrainAutomaticSelection<
	T extends AccountSelectionLike,
>(
	selection: T,
	accessToken: string,
	options: FetchAuthorizedAccountsOptions = {},
): Promise<T> {
	if (!readString(selection.accountIdOverride)) return selection;

	const authorized = await fetchAuthorizedAccounts(accessToken, options);
	const applied = applyAuthorizedAccountConstraint(selection, authorized);
	if (applied.result) warnAboutConstrainedSelection(applied.result);
	return applied.selection;
}

/**
 * Logs the one thing a user needs to know when their selection was overridden:
 * the workspace they picked is not one these credentials can use, so the login
 * landed on the backend's default instead.
 */
export function warnAboutConstrainedSelection(
	result: ConstrainedSelection,
): void {
	if (!result.changed) return;
	logWarn(
		"Selected workspace is not authorized for these credentials; using the account the backend reports as default instead. Re-authenticate while that workspace is active in ChatGPT to bind it.",
		{
			operation: "constrain-account-selection",
			rejectedAccountIdSuffix: result.rejected?.slice(-6),
			appliedAccountIdSuffix: result.accountId.slice(-6),
		},
	);
}
