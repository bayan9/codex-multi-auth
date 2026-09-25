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
		expect(models[0].supported_reasoning_levels).toEqual([{ effort: "high" }, { effort: "low" }]);
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

it("limits advertised context to what every serving account supports",async()=>{
 const catalog=new AccountModelCatalog(async key=>({models:[{slug:'shared',context_window:key==='a'?100000:20000,max_context_window:key==='a'?120000:30000,supported_reasoning_levels:[{effort:key==='a'?'high':'low'}]}]}));
 const [model]=await catalog.list(['a','b']);
 expect(model?.context_window).toBe(20000);expect(model?.max_context_window).toBe(30000);
 expect(model?.supported_reasoning_levels).toEqual([{effort:'high'},{effort:'low'}]);
});


describe("catalog combination regressions", () => {
 const high = {slug:"model-test",supported_reasoning_levels:[{effort:"high"}],service_tiers:[]};
 const fast = {slug:"model-test",supported_reasoning_levels:[{effort:"low"}],service_tiers:[{id:"priority"}]};
 it("does not advertise a speed that cannot serve every visible effort", async () => {
  const catalog = new AccountModelCatalog(async key => ({models:[key === "high" ? high : fast]}));
  const [model] = await catalog.list(["high", "fast"]);
  expect(model?.supported_reasoning_levels).toEqual([{effort:"high"},{effort:"low"}]);
  expect(model?.service_tiers).toEqual([]);
 });
 it.each([["high","fast","both"],["both","fast","high"],["fast","high","both"]])("retains a tier once real accounts cover all combinations: %j", async (...keys) => {
  const both = {...high,service_tiers:[{id:"priority"}]};
  const catalog = new AccountModelCatalog(async key => ({models:[key === "high" ? high : key === "fast" ? fast : both]}));
  const [model] = await catalog.list(keys);
  expect(model?.service_tiers).toEqual([{id:"priority"}]);
 });
});
it("does not keep a default speed after its selectable combinations are removed",async()=>{
 const catalog=new AccountModelCatalog(async key=>({models:[key==='fast'?{slug:'model-test',default_service_tier:'priority',service_tiers:[{id:'priority',name:'Fast',description:'Fixture'}],supported_reasoning_levels:[{effort:'high'}]}:{slug:'model-test',supported_reasoning_levels:[{effort:'low'}]}]}));
 const [model]=await catalog.list(['fast','slow']);
 expect(model?.service_tiers).toEqual([]);expect(model?.default_service_tier).toBe('default');
});


it("fails open on an unknown catalog even when the request sets effort or tier", async () => {
	const catalog = new AccountModelCatalog(vi.fn().mockRejectedValue(new Error("429")));
	expect(await catalog.supports("a", "m", "high")).toBe(true);
	expect(await catalog.supports("a", "m", undefined, "fast")).toBe(true);
	expect(await catalog.supports("a", "m", "high", "fast")).toBe(true);
});
it("advertises only effort and tier pairs that a single account can serve", async () => {
	const catalogs: Record<string, unknown[]> = {
		a: [{ slug: "m", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [] }],
		b: [{ slug: "m", supported_reasoning_levels: [{ effort: "low" }], service_tiers: [{ id: "priority" }] }],
	};
	const catalog = new AccountModelCatalog(async (key) => ({ models: catalogs[key] }));
	const [model] = await catalog.list(["a", "b"]);
	const efforts = (model?.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);
	const tiers = ((model?.service_tiers ?? []) as { id: string }[]).map((tier) => tier.id);
	expect(efforts.sort()).toEqual(["high", "low"]);
	for (const effort of efforts)
		for (const tier of tiers)
			expect((await catalog.supports("a", "m", effort, tier)) || (await catalog.supports("b", "m", effort, tier))).toBe(true);
});
