import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCodexCliStateCache } from "../lib/codex-cli/state.js";
import { setCodexCliActiveSelection } from "../lib/codex-cli/writer.js";
import { syncCodexCliActiveSelectionIfDrifted } from "../lib/codex-manager/login-menu-data.js";
import type { AccountStorageV3 } from "../lib/storage.js";

// #700: the writer maps a stored "org-..." id to the token's
// chatgpt_account_id. The drift check has to apply the same mapping, or every
// org-sourced account reads as drifted and each login-menu render rewrites
// auth.json (replacing the real id_token with the access token).

const jwt = (claims: Record<string, unknown>) =>
	`h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

const ACCESS_TOKEN = jwt({
	exp: 4_102_444_800,
	"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
	"https://api.openai.com/profile": { email: "org@example.com" },
});
const ID_TOKEN = jwt({
	email: "org@example.com",
	"https://api.openai.com/auth": { chatgpt_account_id: "ws-uuid-1" },
});

const ENV_KEYS = [
	"CODEX_CLI_ACCOUNTS_PATH",
	"CODEX_CLI_AUTH_PATH",
	"CODEX_CLI_CONFIG_PATH",
	"CODEX_MULTI_AUTH_SYNC_CODEX_CLI",
	"CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE",
] as const;

describe("org-sourced account alignment with Codex auth.json (#700)", () => {
	let tempDir: string;
	let authPath: string;
	const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
		tempDir = await mkdtemp(join(tmpdir(), "codex-multi-auth-org-align-"));
		authPath = join(tempDir, "auth.json");
		process.env.CODEX_CLI_ACCOUNTS_PATH = join(tempDir, "accounts.json");
		process.env.CODEX_CLI_AUTH_PATH = authPath;
		process.env.CODEX_CLI_CONFIG_PATH = join(tempDir, "config.toml");
		process.env.CODEX_MULTI_AUTH_SYNC_CODEX_CLI = "1";
		process.env.CODEX_MULTI_AUTH_ENFORCE_CLI_FILE_AUTH_STORE = "0";
		clearCodexCliStateCache();
	});

	afterEach(async () => {
		clearCodexCliStateCache();
		for (const key of ENV_KEYS) {
			if (previousEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEnv[key];
		}
		await rm(tempDir, { recursive: true, force: true });
	});

	function storage(): AccountStorageV3 {
		return {
			version: 3,
			activeIndex: 0,
			activeIndexByFamily: {},
			accounts: [
				{
					email: "org@example.com",
					accountId: "org-AbC123",
					accessToken: ACCESS_TOKEN,
					refreshToken: "refresh-org",
					expiresAt: 4_102_444_800_000,
					addedAt: 1,
					lastUsed: 1,
				},
			],
		};
	}

	it("reads a writer-written org account back as aligned and never rewrites it", async () => {
		const account = storage().accounts[0]!;
		await setCodexCliActiveSelection({
			accountId: account.accountId,
			email: account.email,
			accessToken: account.accessToken,
			refreshToken: account.refreshToken,
			idToken: ID_TOKEN,
		});
		const firstWrite = await readFile(authPath, "utf-8");
		const written = JSON.parse(firstWrite) as {
			tokens?: { account_id?: string; id_token?: string };
		};
		expect(written.tokens?.account_id).toBe("ws-uuid-1");
		expect(written.tokens?.id_token).toBe(ID_TOKEN);

		// Several login-menu renders in a row.
		for (let render = 0; render < 3; render += 1) {
			await expect(syncCodexCliActiveSelectionIfDrifted(storage())).resolves.toBe(
				false,
			);
		}

		expect(await readFile(authPath, "utf-8")).toBe(firstWrite);
	});
});
