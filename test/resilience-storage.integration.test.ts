import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../lib/accounts.js";
import { saveAccounts, loadAccounts, clearAccounts, setStoragePathDirect, cloneTrackedAccountStorage, withAccountAndFlaggedStorageTransaction } from "../lib/storage.js";
import { withRetry } from "../lib/fs-retry.js";
const dirs: string[] = [];
afterEach(async () => { setStoragePathDirect(null); for (const dir of dirs.splice(0))
    await withRetry(() => rm(dir, { recursive: true, force: true }), { maxAttempts: 6, backoffMs: 25 }); });
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "resilience-storage-"));
    dirs.push(dir);
    setStoragePathDirect(join(dir, "accounts.json"));
    await saveAccounts({ version: 3, activeIndex: 0, accounts: [{ recordId: "first", accountId: "first", refreshToken: "fixture-first", addedAt: 1, lastUsed: 1, workspaces: [{ id: "personal", enabled: true }, { id: "business", enabled: true }], currentWorkspaceIndex: 0 }] });
    return new AccountManager(undefined, await loadAccounts());
}
it("does not overwrite a CLI workspace exclusion or account addition across repeated daemon saves", async () => {
    const manager = await setup(), cli = (await loadAccounts())!;
    cli.accounts[0]!.workspaces![1]!.enabled = false;
    cli.accounts.push({ recordId: "new", accountId: "new", refreshToken: "fixture-new", addedAt: 2, lastUsed: 2 });
    await saveAccounts(cli);
    manager.getAccountByIndex(0)!.lastUsed = 20;
    await manager.saveToDisk();
    await manager.saveToDisk();
    const result = await loadAccounts();
    expect(result?.accounts).toHaveLength(2);
    expect(result?.accounts[0]?.workspaces?.[1]?.enabled).toBe(false);
    expect(result?.accounts[0]?.lastUsed).toBe(20);
});
it("does not restore accounts after the store was intentionally cleared", async () => {
    const manager = await setup();
    await clearAccounts();
    await manager.saveToDisk();
    expect((await loadAccounts())?.accounts ?? []).toEqual([]);
});
it("merges two loaded CLI snapshots without losing independent edits", async () => {
    await setup();
    const a = (await loadAccounts())!, b = (await loadAccounts())!;
    a.accounts[0]!.accountLabel = "Renamed";
    b.accounts[0]!.workspaces![1]!.enabled = false;
    await saveAccounts(a);
    await saveAccounts(b);
    const result = (await loadAccounts())!;
    expect(result.accounts[0]!.accountLabel).toBe("Renamed");
    expect(result.accounts[0]!.workspaces![1]!.enabled).toBe(false);
});
it("preserves independent edits when a health-check clone moves an account to flagged storage", async () => {
    await setup();
    const check = cloneTrackedAccountStorage((await loadAccounts())!), cli = (await loadAccounts())!;
    cli.accounts.push({ recordId: "new", accountId: "new", refreshToken: "fixture-new", addedAt: 2, lastUsed: 2 });
    await saveAccounts(cli);
    check.accounts = [];
    await withAccountAndFlaggedStorageTransaction(async (_current, persist) => persist(check, { version: 1, accounts: [] }));
    expect((await loadAccounts())?.accounts.map(row => row.recordId)).toEqual(["new"]);
});
