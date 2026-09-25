import { mapWithConcurrency } from "../concurrency.js";
import { clampCatalogContext, mergeCatalogModel, supportsCatalogSettings } from "./catalog-capabilities.js";
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
		{ expires: number; models: CatalogModel[] | null }
	>();
	private readonly pending = new Map<string, Promise<CatalogModel[] | null>>();
	constructor(
		private readonly fetchCatalog: (accountKey: string) => Promise<unknown>,
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 60_000,
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
			if (this.cache.size >= 100)
				this.cache.delete(this.cache.keys().next().value ?? "");
			this.cache.set(key, {
				expires:
					this.now() +
					(models !== null ? this.ttlMs : retryMs),
				models,
			});
			return models;
		})();
		this.pending.set(key, task);
		try {
			return await task;
		} finally {
			this.pending.delete(key);
		}
	}
	async list(accountKeys: string[], referenceKey?: string): Promise<CatalogModel[]> {
		const models = new Map<string, CatalogModel>();

        const catalogs = await mapWithConcurrency([...new Set([...accountKeys, ...(referenceKey ? [referenceKey] : [])])], 3, key => this.read(key));
        for (const catalog of catalogs) for (const model of catalog ?? []) {
            const previous = models.get(model.slug);
            models.set(model.slug, previous ? mergeCatalogModel(previous, model) : model);
        }
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
}
