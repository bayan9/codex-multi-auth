import { buildVisibleModelUnion, supportsModelSettings, modelEntitlements } from "../model-route-policy.js";
import { mapWithConcurrency } from "../concurrency.js";
import { clampCatalogContext, supportsCatalogSettings } from "./catalog-capabilities.js";
import { isRecord } from "../utils.js";

export class CatalogRetryError extends Error {
 constructor(readonly retryAfterMs: number) { super("Catalog temporarily rate limited"); }
}

export type CatalogModel = Record<string, unknown> & { slug: string };

/**
 * Per-proxy discovery cache. Failed refreshes never advertise stale access, but
 * they are "unknown", not "empty": only a successful fetch can exclude a model.
 */
export class AccountModelCatalog {
	private readonly cache = new Map<
		string,
		{ expires: number; checkedAt: number; error: boolean; models: CatalogModel[] | null }
	>();
	private readonly updated = new Set<() => void>();
	private readonly pending = new Map<string, Promise<CatalogModel[] | null>>();
	constructor(
		private readonly fetchCatalog: (accountKey: string) => Promise<unknown>,
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 5 * 60_000,
	) {}
	private async read(key: string): Promise<CatalogModel[] | null> {
		const cached = this.cache.get(key);
		if (cached && cached.expires > this.now()) return cached.models;
		const existing = this.pending.get(key);
		if (existing) return existing;
		const task = (async () => {
			let models: CatalogModel[] | null = null;
            let retryMs = Math.min(this.ttlMs, 5000);
			try {
				const value = await this.fetchCatalog(key);
				if (
					!isRecord(value) ||
					!Array.isArray(value.models) ||
					value.models.length > 1000 ||
					!value.models.every(
						(m) =>
							isRecord(m) &&
							typeof m.slug === "string" &&
							m.slug.length > 0 &&
							m.slug.length < 256,
					)
				) {
					throw new Error("Invalid account model catalog");
				}
				models = value.models as CatalogModel[];
			} catch (error) {
                if (error instanceof CatalogRetryError) retryMs = Math.max(60_000, error.retryAfterMs);
				/* Unknown; list() advertises nothing from it and supports() fails open. */
			}
			if (this.cache.size >= 3000)
				this.cache.delete(this.cache.keys().next().value ?? "");
			this.cache.set(key, {
                checkedAt: this.now(), error: models === null,
				expires:
					this.now() +
					(models !== null ? this.ttlMs : retryMs),
				models,
			});
            for (const notify of this.updated) notify();
			return models;
		})();
		this.pending.set(key, task);
		try {
			return await task;
		} finally {
			this.pending.delete(key);
		}
	}
	/** Picker-only stale-while-refresh view; routing still awaits fresh discovery. */
	cachedList(accountKeys: string[]): CatalogModel[] {
		return buildVisibleModelUnion(accountKeys.map((key, index) => {
			const entry = this.cache.get(key);
			const usable = entry && !entry.error && entry.checkedAt <= this.now() && this.now() - entry.checkedAt < 15 * 60_000;
			return {id: key, kind: "oauth" as const, priority: index, enabled: true, models: usable ? entry.models ?? [] : [], visibleModels: null};
		}));
	}
	invalidate(): void { this.cache.clear(); }
	supportsCached(key: string, model: string, effort?: string, tier?: string): boolean {
		const cached = this.cache.get(key);
		return Boolean(cached && !cached.error && cached.expires > this.now() && cached.models?.some(entry => entry.slug === model && supportsModelSettings(entry, effort, tier)));
	}
	/** Refresh in the background; one fresh eligible route is enough to dispatch.
	 * Unknown/expired capabilities never grant access. The caller still ranks eligible accounts.
	 */
	async prepareRouting(keys: string[], model: string, effort?: string, tier?: string,
		eligible: (key: string) => boolean = () => true, waitMs = 2000,
	): Promise<"ready" | "pending" | "unavailable"> {
		const ready = () => keys.some(key => eligible(key) && this.supportsCached(key, model, effort, tier));
		let notify!: () => void;
		const available = new Promise<void>(resolve => { notify = () => { if (ready()) resolve(); }; });
		this.updated.add(notify);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const refresh = this.list(keys).then(() => undefined, () => undefined);
			if (!ready()) await Promise.race([refresh, available, new Promise<void>(resolve => {timer = setTimeout(resolve, waitMs);})]);
			if (ready()) return "ready";
			return keys.some(key => {const cached = this.cache.get(key); return !cached || cached.error || cached.expires <= this.now();}) ? "pending" : "unavailable";
		} finally {
			if (timer) clearTimeout(timer);
			this.updated.delete(notify);
		}
	}
	async list(accountKeys: string[], referenceKey?: string): Promise<CatalogModel[]> {
		const models = new Map<string, CatalogModel>();

        const catalogs = await mapWithConcurrency([...new Set([...accountKeys, ...(referenceKey ? [referenceKey] : [])])], 3, key => this.read(key));
        const combined = buildVisibleModelUnion(catalogs.map((models, index) => ({id: String(index), kind: "oauth", enabled: true, priority: index, models: models ?? [], visibleModels: null})));
        for (const model of combined) models.set(model.slug, model);
		if (referenceKey) {
            const reference = await this.read(referenceKey);
            return (reference ?? []).map(model => clampCatalogContext(model, models.get(model.slug) ?? model));
        }
        return [...models.values()];
	}
	/** True unless a successfully fetched catalog omits the model. */
	async supports(accountKey: string, model: string, effort?: string, tier?: string): Promise<boolean> {
		const models = await this.read(accountKey);
		return models === null ? !effort && (!tier || tier === "default" || tier === "auto") : models.some((entry) => entry.slug === model && supportsCatalogSettings(entry, effort, tier));
	}
	snapshot(key: string) {
		const entry=this.cache.get(key);
		return {checkedAt:entry?.checkedAt??0,models:entry?.models?.map(m=>m.slug)??[],entitlements:entry?.models?.map(modelEntitlements)??[],error:entry?.error ?? true};
	}
}
