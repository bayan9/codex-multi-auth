import type { AccountMetadataV3, AccountStorageV3 } from "./public-types.js";
import { getAccountIdentityKey } from "./identity.js";
import { isRecord } from "../utils.js";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function conflict(): never {
    throw Object.assign(Error("Account storage changed concurrently; reload before saving."), { code: "ESTALE" });
}
function mergeValue(base: unknown, disk: unknown, local: unknown): unknown {
    if (equal(base, local) || equal(disk, local))
        return structuredClone(disk);
    if (equal(base, disk))
        return structuredClone(local);
    if (isRecord(base) && isRecord(disk) && isRecord(local)) {
        const result: Record<string, unknown> = Object.create(null);
        for (const key of new Set([...Object.keys(base), ...Object.keys(disk), ...Object.keys(local)])) {
            const value = mergeValue(base[key], disk[key], local[key]);
            if (value !== undefined)
                result[key] = value;
        }
        return result;
    }
    return conflict();
}
/** Three-way persistence under the file transaction lock. Disk deletions win over stale runtime state. */
export function mergeAccountSnapshot(base: AccountStorageV3 | null, current: AccountStorageV3 | null, local: AccountStorageV3): AccountStorageV3 {
    if (!base)
        return structuredClone(local);
    if (!current)
        return conflict();
    const aliases = new Map<string, Set<string>>();
    for (const row of [...base.accounts, ...current.accounts, ...local.accounts]) {
        const key = getAccountIdentityKey(row);
        if (!key || !row.recordId)
            continue;
        const ids = aliases.get(key) ?? new Set<string>();
        ids.add(row.recordId);
        aliases.set(key, ids);
    }
    const identity = (row: AccountMetadataV3) => {
        if (row.recordId)
            return row.recordId;
        const key = getAccountIdentityKey(row), ids = key ? aliases.get(key) : undefined;
        return ids?.size === 1 ? [...ids][0] : key;
    };
    const index = (rows: AccountMetadataV3[]) => {
        const map = new Map<string, AccountMetadataV3>();
        for (const row of rows) {
            const key = identity(row);
            if (!key || map.has(key))
                return conflict();
            map.set(key, row);
        }
        return map;
    };
    const old = index(base.accounts), disk = index(current.accounts), proposed = index(local.accounts);
    const accounts: AccountMetadataV3[] = [];
    for (const [key, row] of disk) {
        const prior = old.get(key), next = proposed.get(key);
        if (prior && !next)
            continue; // Explicit local removal of a previously known record.
        if (!prior) {
            if (next && !equal(row, next))
                conflict();
            accounts.push(structuredClone(row));
            continue;
        }
        if (!next)
            continue;
        const lastUsed = Math.max(row.lastUsed, next.lastUsed);
        const merged = mergeValue(prior, { ...row, lastUsed }, { ...next, lastUsed }) as AccountMetadataV3;
        accounts.push(merged);
    }
    for (const [key, row] of proposed)
        if (!old.has(key) && !disk.has(key))
            accounts.push(structuredClone(row));
    const pointer = (storage: AccountStorageV3, value: number | undefined) => { const row = value === undefined ? undefined : storage.accounts[value]; return row ? identity(row) : undefined; };
    const position = (id: string | undefined) => id === undefined ? undefined : accounts.findIndex(row => identity(row) === id);
    const pick = (before: number | undefined, onDisk: number | undefined, next: number | undefined) => {
        const oldId = pointer(base, before), diskId = pointer(current, onDisk), localId = pointer(local, next);
        return position(localId !== oldId ? localId : diskId);
    };
    // Pointer metadata must be compared by identity, never by mutable list positions.
    const fields = (storage: AccountStorageV3) => Object.fromEntries(Object.entries(storage).filter(([key]) => !["accounts", "activeIndex", "activeIndexByFamily", "pinnedAccountIndex"].includes(key)));
    const result = { ...mergeValue(fields(base), fields(current), fields(local)) as Omit<AccountStorageV3, "accounts" | "activeIndex">, accounts, activeIndex: Math.max(0, pick(base.activeIndex, current.activeIndex, local.activeIndex) ?? 0) };
    result.activeIndexByFamily = {};
    for (const family of new Set([...Object.keys(base.activeIndexByFamily ?? {}), ...Object.keys(current.activeIndexByFamily ?? {}), ...Object.keys(local.activeIndexByFamily ?? {})])) {
        const f = family as keyof NonNullable<AccountStorageV3["activeIndexByFamily"]>;
        result.activeIndexByFamily[f] = Math.max(0, pick(base.activeIndexByFamily?.[f], current.activeIndexByFamily?.[f], local.activeIndexByFamily?.[f]) ?? 0);
    }
    const pinned = pick(base.pinnedAccountIndex, current.pinnedAccountIndex, local.pinnedAccountIndex);
    if (pinned !== undefined && pinned >= 0)
        result.pinnedAccountIndex = pinned;
    return result;
}
