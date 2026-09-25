import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyPendingAuth, getPendingAuthPath, prunePendingAuth, recordPendingAuth } from "../lib/storage/pending-auth.js";

let dir: string;
let storagePath: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "pending-auth-"));
	storagePath = join(dir, "accounts.json");
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(dir, { recursive: true, force: true });
});
const rotation = (prior: string, next: string) => ({ priorRefreshToken: prior, refreshToken: next, accessToken: `access-${next}`, expiresAt: 1, at: 1 });
const storage = () => ({ version: 3 as const, activeIndex: 0, accounts: [{ refreshToken: "spent-a", addedAt: 1, lastUsed: 1 }, { refreshToken: "spent-b", addedAt: 1, lastUsed: 1 }] });
function failReads(code: string, times: number) {
	const path = getPendingAuthPath(storagePath);
	const original = fs.readFile.bind(fs);
	let left = times;
	return vi.spyOn(fs, "readFile").mockImplementation((async (file: unknown, ...rest: unknown[]) => {
		if (String(file) === path && left-- > 0) throw Object.assign(new Error("busy"), { code });
		return (original as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
	}) as typeof fs.readFile);
}

it("retries a transient lock and keeps other accounts' pending tokens", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 2);
	await recordPendingAuth(storagePath, rotation("spent-b", "new-b"));
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts.map((a) => a.refreshToken)).toEqual(["new-a", "new-b"]);
});

it("refuses to overwrite when the pending file stays unreadable", async () => {
	await recordPendingAuth(storagePath, rotation("spent-a", "new-a"));
	failReads("EBUSY", 1000);
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	vi.restoreAllMocks();
	const applied = await applyPendingAuth(storagePath, storage());
	expect(applied?.accounts[0]?.refreshToken).toBe("new-a");
});

it("never overwrites a corrupt pending file", async () => {
	const path = getPendingAuthPath(storagePath);
	await fs.writeFile(path, "{torn");
	await expect(recordPendingAuth(storagePath, rotation("spent-b", "new-b"))).rejects.toThrow();
	await expect(prunePendingAuth(storagePath, storage())).rejects.toThrow();
	expect(await fs.readFile(path, "utf8")).toBe("{torn");
});
