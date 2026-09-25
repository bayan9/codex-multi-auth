import { describe, it, expect, vi } from "vitest";
import {
	ApiModelCapabilities,
	parseApiReasoningDocumentation,
} from "../lib/runtime/api-model-capabilities.js";
describe("public API reasoning metadata", () => {
	it("reads only an explicit support statement for the exact model", () => {
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\n`reasoning.effort` supports `low`, `medium` (default), `high`, and `max`.",
			),
		).toEqual(["low", "medium", "high", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning.effort supports: none, low, medium (default), high, xhigh, and max.",
			),
		).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `other`\nReasoning.effort supports: low, high.",
			),
		).toEqual([]);
		expect(
			parseApiReasoningDocumentation(
				"fixture",
				"Model ID: `fixture`\nReasoning effort may include low or high depending on the model.",
			),
		).toEqual([]);
	});
	it("requests public metadata without credentials and fails closed on missing or malformed documentation", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				),
		);
		const reader = new ApiModelCapabilities(fetcher as typeof fetch);
		expect(await reader.reasoning("fixture")).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(
			new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("authorization"),
		).toBe(false);
		expect(await reader.reasoning("../invalid")).toEqual([]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await new ApiModelCapabilities(
				vi.fn(async () => new Response("no", { status: 404 })) as typeof fetch,
			).reasoning("fixture"),
		).toEqual([]);
	});
});

const route = {
	id: "fixture",
	label: "Fixture",
	apiKey: "fixture-key",
	kind: "zdr" as const,
	enabled: true,
	priority: 0,
	visibleModels: ["fixture"],
	probeCapabilities: true,
};
it("verifies API effort and equivalent fast tiers per credential and never treats a downgrade as fast", async () => {
	const calls: RequestInit[] = [];
	let now = 1;
	const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
		if (init?.method !== "POST")
			return new Response("missing", { status: 404 });
		calls.push(init);
		const body = JSON.parse(String(init.body));
		if (body.service_tier === "ultrafast")
			return Response.json({ service_tier: "default" });
		if (body.service_tier === "fast")
			return Response.json({ service_tier: "priority" });
		if (!["low", "high"].includes(body.reasoning?.effort))
			return new Response("unsupported", { status: 400 });
		return Response.json({
			service_tier: "default",
			reasoning: body.reasoning,
		});
	});
	const reader = new ApiModelCapabilities(fetcher as typeof fetch, () => now);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.supported_reasoning_levels).toEqual(
		expect.arrayContaining([
			{ effort: "low", description: expect.any(String) },
			{ effort: "high", description: expect.any(String) },
		]),
	);
	expect(model?.service_tiers).toEqual([
		{ id: "priority", name: "Fast", description: expect.any(String) },
	]);
	expect(model?.capability_probe_status).toMatchObject({
		ultrafast: "downgraded",
		fast: "verified",
	});
	expect(
		calls.every(
			(c) =>
				new Headers(c.headers).get("authorization") === "Bearer fixture-key" &&
				JSON.parse(String(c.body)).store === false &&
				JSON.parse(String(c.body)).max_output_tokens === 16,
		),
	).toBe(true);
	const count = calls.length;
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(calls).toHaveLength(count);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		apiKey: "other-fixture-key",
	});
	expect(calls.length).toBeGreaterThan(count);
	now += 900001;
	await reader.enrich([{ slug: "fixture" }], false, route);
	expect(calls.length).toBeGreaterThan(count * 2);
});
it("never runs paid probes without opt-in and never calls an authentication failure unsupported", async () => {
	const fetcher = vi.fn(async (_u: unknown, i?: RequestInit) =>
		i?.method === "POST"
			? new Response("unauthorized", { status: 401 })
			: new Response("missing", { status: 404 }),
	);
	const reader = new ApiModelCapabilities(fetcher as typeof fetch);
	await reader.enrich([{ slug: "fixture" }], false, {
		...route,
		probeCapabilities: false,
	});
	expect(fetcher.mock.calls.every((c) => c[1]?.method !== "POST")).toBe(true);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(model?.service_tiers).toEqual([]);
	expect(model?.capability_probe_status).toMatchObject({
		fast: "unverified",
		ultrafast: "unverified",
	});
});

it("coalesces concurrent paid probes for the same credential and model", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await Promise.all([
		reader.enrich([{ slug: "fixture" }], false, route),
		reader.enrich([{ slug: "fixture" }], false, route),
	]);
	expect(posts).toBe(9);
});

it("explicit checks bypass the paid-probe cache while automatic refreshes reuse it", async () => {
	let posts = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low.",
				);
			posts++;
			return Response.json({
				service_tier: JSON.parse(String(i.body)).service_tier,
			});
		}) as typeof fetch,
	);
	await reader.enrich([{ slug: "fixture" }], true, route);
	await reader.enrich([{ slug: "fixture" }], true, route);
	expect(posts).toBe(9);
	await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(posts).toBe(18);
});

it("runs independent probes concurrently with a shared four-request limit and stable effort ordering", async () => {
	let active = 0,
		peak = 0;
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, i?: RequestInit) => {
			if (i?.method !== "POST") return new Response("missing", { status: 404 });
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			const body = JSON.parse(String(i.body));
			return Response.json({
				reasoning: body.reasoning,
				service_tier: body.service_tier ?? "default",
			});
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], false, route);
	expect(peak).toBe(4);
	expect(model?.supported_reasoning_levels).toEqual(
		["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
			(effort) => ({ effort, description: expect.any(String) }),
		),
	);
});

it("discovers newly entitled effort levels absent from documentation and excludes rejected levels", async () => {
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high.",
				);
			const body = JSON.parse(String(init.body));
			if (!body.service_tier && body.reasoning.effort === "xhigh")
				return Response.json({ reasoning: { effort: "xhigh" } });
			return Response.json(
				{
					error: {
						param: body.service_tier ? "service_tier" : "reasoning.effort",
					},
				},
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.supported_reasoning_levels).toEqual(
		["low", "medium", "high", "xhigh", "ultra"].map((effort) => ({
			effort,
			description: expect.any(String),
		})),
	);
	expect(model?.capability_probe_status).toMatchObject({
		"effort:xhigh": "verified",
		"effort:max": "unsupported",
	});
});

it("keeps native Ultra separate from API effort probes and maps it to a supported maximum", async () => {
	const calls: string[] = [];
	const reader = new ApiModelCapabilities(
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			if (init?.method !== "POST")
				return new Response(
					"Model ID: `fixture`\nReasoning.effort supports: low, medium, high, max.",
				);
			const body = JSON.parse(String(init.body));
			calls.push(body.reasoning?.effort);
			return Response.json(
				{ error: { param: "reasoning.effort" } },
				{ status: 400 },
			);
		}) as typeof fetch,
	);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.supported_reasoning_levels).toContainEqual({
		effort: "ultra",
		description: expect.any(String),
	});
	expect(model?.multi_agent_reasoning_effort).toBe("max");
	expect(calls).not.toContain("ultra");
	expect(model?.capability_probe_status).not.toHaveProperty("effort:ultra");
	const [unknown] = await new ApiModelCapabilities(
		vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
	).enrich([{ slug: "fixture" }]);
	expect(unknown?.supported_reasoning_levels).toEqual([]);
	expect(unknown?.multi_agent_reasoning_effort).toBeNull();
});

it("reads newly named efforts from exact model documentation without accepting prose or control characters", () => {
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high, and deeper_v2.",
		),
	).toEqual(["low", "high", "deeper_v2"]);
	expect(
		parseApiReasoningDocumentation(
			"fixture",
			"Model ID: `fixture`\nReasoning.effort supports: low, high depending on access.",
		),
	).toEqual([]);
});

it("checks Responses tool compatibility before advertising an explicitly rejected API model", async () => {
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools)
			return Response.json(
				{ error: { code: "model_not_found", param: "model" } },
				{ status: 404 },
			);
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(model?.capability_probe_status).toMatchObject({
		responses: "unsupported",
	});
	const { buildVisibleModelUnion, resolveModelRoute } = await import(
		"../lib/model-route-policy.js"
	);
	const catalog = {
		id: "fixture",
		kind: "zdr" as const,
		enabled: true,
		priority: 0,
		visibleModels: ["fixture"],
		models: [model!],
	};
	expect(buildVisibleModelUnion([catalog])).toEqual([]);
	expect(resolveModelRoute("zdr/fixture", [catalog]).candidates).toEqual([]);
});

it("verifies a tool call with a tiny benign payload and reports it in check entitlements", async () => {
	let probe: Record<string, unknown> | undefined;
	const reader = new ApiModelCapabilities((async (_url, init) => {
		if (init?.method !== "POST")
			return new Response(
				"Model ID: `fixture`\nReasoning.effort supports: low, high.",
			);
		const body = JSON.parse(String(init.body));
		if (body.tools) {
			probe = body;
			return Response.json({
				output: [
					{ type: "function_call", name: "capability_probe", arguments: "{}" },
				],
			});
		}
		return Response.json({
			reasoning: body.reasoning,
			service_tier: body.service_tier ?? "default",
		});
	}) as typeof fetch);
	const [model] = await reader.enrich([{ slug: "fixture" }], true, route, true);
	expect(probe).toMatchObject({
		store: false,
		max_output_tokens: 16,
		tool_choice: { type: "function", name: "capability_probe" },
	});
	const { modelEntitlements } = await import("../lib/model-route-policy.js");
	expect(modelEntitlements(model!).probes).toMatchObject({
		responses: "verified",
	});
});
