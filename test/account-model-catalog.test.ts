import { describe, expect, it, vi } from "vitest";
import { AccountModelCatalog } from "../lib/runtime/account-model-catalog.js";

describe("live account model catalogs", () => {
	it("routes from a fresh eligible catalog without waiting for unrelated discovery", async () => {
		let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
		const catalog=new AccountModelCatalog(async key=>{if(key==="slow")await gate;return {models:[{slug:"model"}]};});
		await catalog.list(["ready"]);
		try { expect(await catalog.prepareRouting(["ready","slow"],"model")).toBe("ready"); }
		finally {release();await catalog.list(["slow"]);}
	});
	it("stops waiting as soon as a cold eligible candidate resolves", async () => {
		let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
		const catalog=new AccountModelCatalog(async key=>{if(key==="slow")await gate;return {models:[{slug:"model"}]};});
		try {expect(await catalog.prepareRouting(["slow","ready"],"model",undefined,undefined,()=>true,10000)).toBe("ready");}
		finally {release();await catalog.list(["slow"]);}
	});
	it("bounds cold discovery and never treats an expired entitlement as current",async()=>{
        vi.useFakeTimers();
		let now=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
		const catalog=new AccountModelCatalog(async()=>{if(now)await gate;return {models:[{slug:"model"}]};},()=>now,100);
		await catalog.list(["a"]);now=101;
		try {
			expect(catalog.supportsCached("a","model")).toBe(false);
			const pending=catalog.prepareRouting(["a"],"model",undefined,undefined,()=>true,10);
            await vi.advanceTimersByTimeAsync(10);
            expect(await pending).toBe("pending");
		}finally{release();await catalog.list(["a"]);vi.useRealTimers();}
	});
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

it("distinguishes a successful empty catalog from an unavailable workspace", async () => {
 const catalog=new AccountModelCatalog(async key=>{if(key==="failed") throw Error("failed"); return {models:[]};});
 await catalog.list(["empty","failed"]);
 expect(catalog.snapshot("empty").error).toBe(false);
 expect(catalog.snapshot("failed").error).toBe(true);
});

it("starts the next workspace as soon as any discovery slot finishes",async()=>{
 vi.useFakeTimers();
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const started:string[]=[];
 const catalog=new AccountModelCatalog(async key=>{started.push(key);if(key==="slow") await gate;return {models:[{slug:key}]};});
 const pending=catalog.list(["slow","two","three","four"]);
 try {await vi.waitFor(()=>expect(started).toContain("four"),{timeout:100});}
 finally{release();await pending;vi.useRealTimers();}
 expect(started).toEqual(["slow","two","three","four"]);
});

it("keeps recent account catalogs for five minutes and bounds stale picker data",async()=>{
 let now=1000;const fetchCatalog=vi.fn(async()=>({models:[{slug:"cached-model"}]}));
 const catalog=new AccountModelCatalog(fetchCatalog,()=>now);
 await catalog.list(["a"]);now+=4*60_000;
 await catalog.list(["a"]);expect(fetchCatalog).toHaveBeenCalledTimes(1);
 now+=2*60_000;
 expect(catalog.cachedList(["a"]).map(m=>m.slug)).toEqual(["cached-model"]);
 now+=10*60_000;
 expect(catalog.cachedList(["a"])).toEqual([]);
 await catalog.list(["a"]);expect(fetchCatalog).toHaveBeenCalledTimes(2);
});

describe("catalog combination regressions", () => {
 const high = {slug:"model-test",supported_reasoning_levels:[{effort:"high"}],service_tiers:[]};
 const fast = {slug:"model-test",supported_reasoning_levels:[{effort:"low"}],service_tiers:[{id:"priority",name:"Fast",description:"Fixture speed"}]};
 it("does not advertise a speed that cannot serve every visible effort", async () => {
  const catalog = new AccountModelCatalog(async key => ({models:[key === "high" ? high : fast]}));
  const [model] = await catalog.list(["high", "fast"]);
  expect(model?.supported_reasoning_levels).toEqual([{effort:"high"},{effort:"low"}]);
  expect(model?.service_tiers).toEqual([]);
 });
 it.each([["high","fast","both"],["both","fast","high"],["fast","high","both"]])("retains a tier once real accounts cover all combinations: %j", async (...keys) => {
  const both = {...high,service_tiers:[{id:"priority",name:"Fast",description:"Fixture speed"}]};
  const catalog = new AccountModelCatalog(async key => ({models:[key === "high" ? high : key === "fast" ? fast : both]}));
  const [model] = await catalog.list(keys);
  expect(model?.service_tiers).toEqual([{id:"priority",name:"Fast",description:"Fixture speed"}]);
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
	expect(model).toBeDefined();
	const efforts = (model!.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort);
	const tiers = ((model?.service_tiers ?? []) as { id: string }[]).map((tier) => tier.id);
	expect(efforts.sort()).toEqual(["high", "low"]);
	for (const effort of efforts)
		for (const tier of tiers)
			expect((await catalog.supports("a", "m", effort, tier)) || (await catalog.supports("b", "m", effort, tier))).toBe(true);
});
