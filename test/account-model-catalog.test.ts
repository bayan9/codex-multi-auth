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
		try {expect(await catalog.prepareRouting(["slow","ready"],"model",undefined,undefined,()=>true,30)).toBe("ready");}
		finally {release();await catalog.list(["slow"]);}
	});
	it("bounds cold discovery and never treats an expired entitlement as current",async()=>{
		let now=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
		const catalog=new AccountModelCatalog(async()=>{if(now)await gate;return {models:[{slug:"model"}]};},()=>now,100);
		await catalog.list(["a"]);now=101;
		try {
			expect(catalog.supportsCached("a","model")).toBe(false);
			expect(await catalog.prepareRouting(["a"],"model",undefined,undefined,()=>true,10)).toBe("pending");
		}finally{release();await catalog.list(["a"]);}
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
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const started:string[]=[];
 const catalog=new AccountModelCatalog(async key=>{started.push(key);if(key==="slow") await gate;return {models:[{slug:key}]};});
 const pending=catalog.list(["slow","two","three","four"]);
 try {await vi.waitFor(()=>expect(started).toContain("four"),{timeout:100});}
 finally{release();await pending;}
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
