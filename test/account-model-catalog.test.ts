import { describe, expect, it, vi } from "vitest";
import { AccountModelCatalog } from "../lib/runtime/account-model-catalog.js";

describe("live account model catalogs", () => {
	it("unions live models, preserves future metadata, and respects a pin", async () => {
		const fetchCatalog = vi.fn(async (key: string) => ({
			models:
				key === "a"
					? [
							{
								slug: "shared",
								supported_reasoning_levels: [{ effort: "high" }],
							},
							{
								slug: "future-model",
								visibility: "list",
								context_window: 123456,
							},
						]
					: [
							{
								slug: "shared",
								supported_reasoning_levels: [{ effort: "low" }],
							},
							{ slug: "hidden-model", visibility: "hide" },
						],
		}));
		const catalog = new AccountModelCatalog(fetchCatalog);
		const models = await catalog.list(["a", "b"]);
		expect(models.map((m) => m.slug)).toEqual([
			"shared",
			"future-model",
			"hidden-model",
		]);
		expect(models[1]).toMatchObject({
			context_window: 123456,
			visibility: "list",
		});
		expect(models[0].supported_reasoning_levels).toEqual([{ effort: "high" }]);
		expect((await catalog.list(["b"])).map((m) => m.slug)).toEqual([
			"shared",
			"hidden-model",
		]);
		expect(await catalog.supports("a", "hidden-model")).toBe(false);
		expect(await catalog.supports("b", "hidden-model")).toBe(true);
		expect(fetchCatalog).toHaveBeenCalledTimes(2);
	});
	it("expires capabilities and does not retain revoked models after refresh failure", async () => {
		let now = 0;
		const fetchCatalog = vi
			.fn()
			.mockResolvedValueOnce({ models: [{ slug: "old" }] })
			.mockRejectedValue(new Error("credential expired"));
		const catalog = new AccountModelCatalog(fetchCatalog, () => now, 100);
		expect(await catalog.supports("a", "old")).toBe(true);
		now = 101;
		expect(await catalog.list(["a"])).toEqual([]);
		// A failed refresh is unknown, not proof the model was revoked.
		expect(await catalog.supports("a", "old")).toBe(true);
	});
	it("treats a failed catalog fetch as unknown so a transient outage cannot exclude a model", async () => {
		const fetchCatalog = vi.fn().mockRejectedValue(new Error("429"));
		const catalog = new AccountModelCatalog(fetchCatalog);
		expect(await catalog.supports("a", "any-model")).toBe(true);
		expect(await catalog.list(["a"])).toEqual([]);
		expect(fetchCatalog).toHaveBeenCalledTimes(1);
	});
	it("still excludes a model that a successful fetch does not advertise", async () => {
		const catalog = new AccountModelCatalog(async () => ({
			models: [{ slug: "present" }],
		}));
		expect(await catalog.supports("a", "absent")).toBe(false);
	});
	it("isolates failed accounts and coalesces simultaneous discovery", async () => {
		const fetchCatalog = vi.fn(async (key: string) => {
			if (key === "bad") throw Error("unavailable");
			return { models: [{ slug: "good" }] };
		});
		const catalog = new AccountModelCatalog(fetchCatalog);
		const [a, b] = await Promise.all([
			catalog.list(["bad", "ok"]),
			catalog.list(["ok"]),
		]);
		expect(a).toEqual(b);
		expect(fetchCatalog).toHaveBeenCalledTimes(2);
	});
	it("rejects malformed catalogs instead of inventing model availability", async () => {
		const catalog = new AccountModelCatalog(async () => ({
			models: [{ slug: "valid" }, { slug: 0 }],
		}));
		expect(await catalog.list(["a"])).toEqual([]);
	});
});
