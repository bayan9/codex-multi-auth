import { isRecord } from "../utils.js";

export type CatalogModel = Record<string, unknown> & { slug: string };

/** Per-proxy discovery cache. Failed refreshes never advertise stale access. */
export class AccountModelCatalog {
	private readonly cache = new Map<
		string,
		{ expires: number; models: CatalogModel[] }
	>();
	private readonly pending = new Map<string, Promise<CatalogModel[]>>();
	constructor(
		private readonly fetchCatalog: (accountKey: string) => Promise<unknown>,
		private readonly now: () => number = Date.now,
		private readonly ttlMs = 60_000,
	) {}
	private async read(key: string): Promise<CatalogModel[]> {
		const cached = this.cache.get(key);
		if (cached && cached.expires > this.now()) return cached.models;
		const existing = this.pending.get(key);
		if (existing) return existing;
		const task = (async () => {
			let models: CatalogModel[] = [];
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
			} catch {
				/* Fail closed; another account may still have a usable catalog. */
			}
			if (this.cache.size >= 100)
				this.cache.delete(this.cache.keys().next().value ?? "");
			this.cache.set(key, {
				expires:
					this.now() +
					(models.length ? this.ttlMs : Math.min(this.ttlMs, 5000)),
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
	async list(accountKeys: string[]): Promise<CatalogModel[]> {
		const models = new Map<string, CatalogModel>();
		// Bounded fan-out; retain whole model records rather than inventing combinations of capabilities.
		for (let i = 0; i < accountKeys.length; i += 3) {
			for (const catalog of await Promise.all(
				accountKeys.slice(i, i + 3).map((key) => this.read(key)),
			)) {
				for (const model of catalog)
					if (!models.has(model.slug)) models.set(model.slug, model);
			}
		}
		return [...models.values()];
	}
	async supports(accountKey: string, model: string): Promise<boolean> {
		return (await this.read(accountKey)).some((entry) => entry.slug === model);
	}
}
