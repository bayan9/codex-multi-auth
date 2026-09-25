import { describe, expect, it } from "vitest";
import {
	resolveModelRoute,
	buildVisibleModelUnion,
} from "../lib/model-route-policy.js";
import type { RouteCatalog } from "../lib/model-route-policy.js";
const catalogs: RouteCatalog[] = [
	{
		id: "oauth-a",
		kind: "oauth",
		priority: 0,
		enabled: true,
		models: [{ slug: "shared" }, { slug: "limited" }],
		visibleModels: null,
	},
	{
		id: "oauth-b",
		kind: "oauth",
		priority: 1,
		enabled: true,
		models: [{ slug: "shared" }],
		visibleModels: null,
	},
	{
		id: "api-a",
		kind: "api",
		priority: 0,
		enabled: true,
		models: [{ slug: "shared" }, { slug: "hidden" }],
		visibleModels: ["shared"],
	},
	{
		id: "zdr-a",
		kind: "zdr",
		priority: 1,
		enabled: true,
		models: [{ slug: "shared" }],
		visibleModels: ["shared"],
	},
	{
		id: "zdr-b",
		kind: "zdr",
		priority: 0,
		enabled: true,
		models: [{ slug: "shared" }],
		visibleModels: ["shared"],
	},
];
describe("explicit model route pools", () => {
	it("unions native models and exposes only selected API models as separate entries", () => {
		expect(buildVisibleModelUnion(catalogs).map((m) => m.slug)).toEqual([
			"shared",
			"limited",
			"api/shared",
			"zdr/shared",
		]);
	});
	it("limits normal models to OAuth accounts that advertise the model", () => {
		expect(
			resolveModelRoute("limited", catalogs).candidates.map((c) => c.id),
		).toEqual(["oauth-a"]);
		expect(
			resolveModelRoute("shared", catalogs).candidates.map((c) => c.id),
		).toEqual(["oauth-a", "oauth-b"]);
	});
	it("keeps ZDR failover exclusively within its pool and orders candidates by priority", () => {
		const result = resolveModelRoute("zdr/shared", catalogs);
		expect(result.upstreamModel).toBe("shared");
		expect(result.candidates.map((c) => c.id)).toEqual(["zdr-b", "zdr-a"]);
		expect(resolveModelRoute("zdr/limited", catalogs).candidates).toEqual([]);
	});
	it("never exposes hidden API models even when the caller guesses an alias", () => {
		expect(resolveModelRoute("api/hidden", catalogs).candidates).toEqual([]);
	});
	it("excludes disabled credentials and does not reuse unavailable catalogs", () => {
		const unavailable = catalogs.map((c) => ({ ...c, enabled: false }));
		expect(buildVisibleModelUnion(unavailable)).toEqual([]);
		expect(resolveModelRoute("zdr/shared", unavailable).candidates).toEqual([]);
	});
	it("rejects malformed aliases and aliases colliding with raw catalog IDs", () => {
		expect(() => resolveModelRoute("zdr/", catalogs)).toThrow();
		expect(
			buildVisibleModelUnion([
				{ ...catalogs[0]!, models: [{ slug: "zdr/forged" }] },
			]),
		).toEqual([]);
	});
	it("unions explicitly advertised efforts while retaining per-credential eligibility", () => {
		const first = {
			...catalogs[0]!,
			models: [
				{ slug: "shared", supported_reasoning_levels: [{ effort: "low" }] },
			],
		};
		const second = {
			...catalogs[1]!,
			models: [
				{ slug: "shared", supported_reasoning_levels: [{ effort: "high" }] },
			],
		};
		expect(
			buildVisibleModelUnion([first, second])[0]?.supported_reasoning_levels,
		).toEqual([{ effort: "low" }, { effort: "high" }]);
	});
});

it("prices explicit API aliases using their actual upstream model without guessing unknown prices", async () => {
	const { getUsageModelPricing, listUsageModelPricing } = await import(
		"../lib/usage/pricing.js"
	);
	const [model] = Object.keys(listUsageModelPricing());
	expect(model).toBeTruthy();
	for (const pool of ["api", "zdr"])
		expect(getUsageModelPricing(`${pool}/${model}`)).toEqual(
			getUsageModelPricing(model),
		);
	expect(getUsageModelPricing("zdr/unpriced-fixture")).toBeNull();
});

it("exposes native speed controls without duplicate models and routes the requested combination", () => {
	const slow = {
		...catalogs[0]!,
		models: [
			{
				slug: "shared",
				display_name: "Shared",
				supported_reasoning_levels: [{ effort: "low" }],
			},
		],
	};
	const fast = {
		...catalogs[1]!,
		models: [
			{
				slug: "shared",
				display_name: "Shared",
				service_tiers: [
					{
						id: "accelerated",
						name: "Accelerated",
						description: "Fixture speed",
					},
				],
				supported_reasoning_levels: [{ effort: "high" }],
			},
		],
	};
	const list = buildVisibleModelUnion([slow, fast]);
	expect(list.map((m) => m.slug)).toEqual(["shared"]);
	expect(list[0]?.service_tiers).toEqual(fast.models[0]!.service_tiers);
	expect(list[0]?.default_service_tier).toBeUndefined();
	expect(
		resolveModelRoute("shared", [slow, fast], {
			serviceTier: "accelerated",
			reasoningEffort: "high",
		}).candidates.map((c) => c.id),
	).toEqual(["oauth-b"]);
	expect(
		resolveModelRoute("shared", [slow, fast], {
			serviceTier: "accelerated",
			reasoningEffort: "low",
		}).candidates,
	).toEqual([]);
	expect(
		resolveModelRoute("zdr/speed/accelerated/shared", [
			slow,
			fast,
			...catalogs.slice(2),
		]).candidates,
	).toEqual([]);
});

it("treats Fast and Priority as the same tier without treating Standard as equivalent", () => {
	const eligible = {
		...catalogs[3]!,
		models: [
			{
				slug: "shared",
				service_tiers: [
					{ id: "priority", name: "Fast", description: "Fast API processing" },
				],
			},
		],
	};
	expect(
		resolveModelRoute("zdr/speed/fast/shared", [eligible], {
			serviceTier: "priority",
		}).candidates,
	).toHaveLength(1);
	expect(() =>
		resolveModelRoute("zdr/speed/fast/shared", [eligible], {
			serviceTier: "default",
		}),
	).toThrow("Conflicting");
	expect(
		resolveModelRoute("zdr/speed/ultrafast/shared", [eligible]).candidates,
	).toHaveLength(0);
});

it("deduplicates native Fast/Priority controls within each pool without changing defaults or mutating catalogs", () => {
	const model = (id: string) => ({
		slug: "shared",
		service_tiers: [{ id, name: "Fast", description: "Fixture" }],
		default_service_tier: "default",
	});
	const input = [
		{ ...catalogs[3]!, models: [model("fast")] },
		{ ...catalogs[4]!, models: [model("priority")] },
		{ ...catalogs[0]!, models: [{ slug: "shared" }] },
	];
	const before = JSON.stringify(input);
	const list = buildVisibleModelUnion(input);
	expect(list.map((m) => m.slug).sort()).toEqual(["shared", "zdr/shared"]);
	expect(list.find((m) => m.slug === "zdr/shared")).toMatchObject({
		service_tiers: [{ id: "priority" }],
		default_service_tier: "default",
	});
	expect(list.find((m) => m.slug === "shared")?.service_tiers).toBeUndefined();
	expect(JSON.stringify(input)).toBe(before);
});

it("unions access programs within each model pool without changing credential eligibility metadata",()=>{
 const a={...catalogs[3]!,models:[{slug:"shared",available_access_programs:{research:["standard"]}}]};
 const b={...catalogs[4]!,models:[{slug:"shared",available_access_programs:{research:["extended"]}}]};
 const oauth={...catalogs[0]!,models:[{slug:"shared",available_access_programs:{research:["private"]}}]};
 const before=JSON.stringify([a,b,oauth]);
 const list=buildVisibleModelUnion([a,b,oauth]);
 expect(list.find(m=>m.slug==="zdr/shared")?.available_access_programs).toEqual({research:["extended","standard"]});
 expect(list.find(m=>m.slug==="shared")?.available_access_programs).toEqual({research:["private"]});
 expect(JSON.stringify([a,b,oauth])).toBe(before);
});
