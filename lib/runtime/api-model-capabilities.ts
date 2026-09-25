import { mapWithConcurrency } from "../concurrency.js";
import { classifyCapabilityFailure } from "./runtime-capability-failures.js";
import { createHash } from "node:crypto";
import type { ApiRouteCredential } from "../api-route-store.js";
import {
	canonicalServiceTier,
	type RouteModel,
} from "../model-route-policy.js";
import { isRecord } from "../utils.js";

const efforts = new Set([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
/** Read the explicit model-specific statement, never surrounding examples or another model's settings. */
export function parseApiReasoningDocumentation(
	id: string,
	text: string,
): string[] {
	if (text.match(/^Model ID:\s*`([^`]+)`/m)?.[1] !== id) return [];
	const statement = text.match(
		/`?reasoning\.effort`?\s+supports\s*:?\s*([^\n.]+)\./i,
	)?.[1];
	if (!statement) return [];
	const values = statement
		.replace(/`|\(default\)/g, " ")
		.split(/,|\band\b/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (
		!values.length ||
		values.length > 16 ||
		values.some(
			(v) =>
				!/^[a-z][a-z0-9_-]{0,31}$/.test(v) ||
				v === "ultra" ||
				v === "persistent",
		)
	)
		return [];
	return [...new Set(values)];
}
type ProbeResult = {
	at: number;
	levels: string[];
	tiers: string[];
	status: Record<string, string>;
};
export class ApiModelCapabilities {
	private activeProbes = 0;
	private readonly probeWaiters: Array<() => void> = [];
	private async withProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
		if (this.activeProbes >= 4)
			await new Promise<void>((resolve) => this.probeWaiters.push(resolve));
		else this.activeProbes++;
		try {
			return await operation();
		} finally {
			const next = this.probeWaiters.shift();
			if (next) next();
			else this.activeProbes--;
		}
	}
	private readonly inFlight = new Map<string, Promise<ProbeResult>>();
	private readonly probes = new Map<
		string,
		{
			at: number;
			levels: string[];
			tiers: string[];
			status: Record<string, string>;
		}
	>();
	private readonly cache = new Map<string, { at: number; levels: string[] }>();
	constructor(
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}
	async reasoning(id: string, refresh = false): Promise<string[]> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) return [];
		const cached = this.cache.get(id);
		if (!refresh && cached && cached.at + 60000 > this.now())
			return cached.levels;
		let levels: string[] = [];
		try {
			const response = await this.fetchImpl(
				`https://developers.openai.com/api/docs/models/${encodeURIComponent(id)}.md`,
				{ redirect: "error", signal: AbortSignal.timeout(5000) },
			);
			if (!response.ok) {
				await response.body?.cancel();
				throw Error("Documentation unavailable");
			}
			const reader = response.body?.getReader();
			if (!reader) throw Error("No documentation");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 256 * 1024) throw Error("Documentation too large");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			levels = parseApiReasoningDocumentation(
				id,
				Buffer.concat(chunks).toString("utf8"),
			);
		} catch {
			// An outage is not a capability revocation. Keep last successful evidence.
            levels = cached?.levels ?? [];
		}
		if (this.cache.size >= 1000)
			this.cache.delete(this.cache.keys().next().value ?? "");
		this.cache.set(id, { at: this.now(), levels });
		return levels;
	}
	private async probe(
		route: ApiRouteCredential,
		id: string,
		documented: string[],
		force = false,
	) {
		const key = createHash("sha256")
			.update(route.id)
			.update("\0")
			.update(route.apiKey)
			.update("\0")
			.update(id)
			.digest("hex");
		const old = this.probes.get(key);
		if (!force && old && old.at + 900000 > this.now()) return old;
		const running = this.inFlight.get(key);
		if (running) return running;
		const pending = this.runProbe(route, id, documented, key).finally(() =>
			this.inFlight.delete(key),
		);
		this.inFlight.set(key, pending);
		return pending;
	}
	private async runProbe(
		route: ApiRouteCredential,
		id: string,
		documented: string[],
		key: string,
	): Promise<ProbeResult> {
		const result = {
			at: this.now(),
			levels: [...documented],
			tiers: [] as string[],
			status: {} as Record<string, string>,
		};
		let credentialUnavailable = false;
		const attempt = async (setting: {
			effort?: string;
			tier?: string;
			compatibility?: boolean;
		}): Promise<string> =>
			this.withProbeSlot(async () => {
				if (credentialUnavailable) return "unverified";
				try {
					const response = await this.fetchImpl(
						"https://api.openai.com/v1/responses",
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${route.apiKey}`,
								"content-type": "application/json",
							},
							redirect: "error",
							signal: AbortSignal.timeout(15000),
							body: JSON.stringify({
								model: id,
								input: "Reply OK.",
								store: false,
								max_output_tokens: 16,
								...(setting.compatibility
									? {
											tools: [
												{
													type: "function",
													name: "capability_probe",
													parameters: {
														type: "object",
														properties: {},
														required: [],
														additionalProperties: false,
													},
													strict: true,
												},
											],
											tool_choice: {
												type: "function",
												name: "capability_probe",
											},
										}
									: {}),
								...(setting.effort
									? { reasoning: { effort: setting.effort } }
									: {}),
								...(setting.tier ? { service_tier: setting.tier } : {}),
							}),
						},
					);
					if ([401, 403, 429].includes(response.status))
						credentialUnavailable = true;
					// Probe bodies are tiny, but an upstream error must not grow local memory unboundedly.
					const reader = response.body?.getReader();
					if (!reader) return "unverified";
					const chunks: Uint8Array[] = [];
					let bytes = 0;
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							if (bytes > 256 * 1024) throw Error("Probe response too large");
							chunks.push(value);
						}
					} finally {
						await reader.cancel();
					}
					let data: unknown;
					try {
						data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
					} catch {
						return "unverified";
					}
					if (!response.ok) {
						if (setting.compatibility) {
							const error =
								isRecord(data) && isRecord(data.error) ? data.error : null;
							return classifyCapabilityFailure(response.status, data) ===
								"model" ||
								(response.status === 400 &&
									error &&
									["tools", "tool_choice"].includes(String(error.param)) &&
									["unsupported_parameter", "unsupported_value"].includes(
										String(error.code),
									))
								? "unsupported"
								: "unverified";
						}
						const error =
							isRecord(data) && isRecord(data.error) ? data.error : null;
						return response.status === 400 &&
							error &&
							typeof error.param === "string" &&
							["reasoning.effort", "reasoning", "service_tier"].includes(
								error.param,
							)
							? "unsupported"
							: "unverified";
					}
					if (setting.compatibility)
						return isRecord(data) &&
							Array.isArray(data.output) &&
							data.output.some(
								(item) =>
									isRecord(item) &&
									item.type === "function_call" &&
									item.name === "capability_probe",
							)
							? "verified"
							: "unverified";
					if (!setting.tier)
						return isRecord(data) &&
							isRecord(data.reasoning) &&
							data.reasoning.effort === setting.effort
							? "verified"
							: "unverified";
					if (!isRecord(data) || typeof data.service_tier !== "string")
						return "unverified";
					return canonicalServiceTier(data.service_tier) ===
						canonicalServiceTier(setting.tier)
						? "verified"
						: "downgraded";
				} catch {
					return "unverified";
				}
			});
		{
			const checked = await Promise.all(
				[...efforts]
					.filter((effort) => !documented.includes(effort))
					.map(async (effort) => ({
						effort,
						status: await attempt({ effort }),
					})),
			);
			for (const { effort, status } of checked) {
				result.status[`effort:${effort}`] = status;
				if (status === "verified") result.levels.push(effort);
			}
		}
		const effort = result.levels.includes("low") ? "low" : result.levels[0];
		result.status.responses = await attempt({ compatibility: true, effort });
		const checkedTiers = await Promise.all(
			["fast", "ultrafast"].map(async (tier) => ({
				tier,
				status: await attempt({ tier: tier === "fast" ? "priority" : tier, effort }),
			})),
		);
		for (const { tier, status } of checkedTiers) {
			result.status[tier] = status;
			if (status === "verified") result.tiers.push(tier);
		}
		result.at = this.now();
		if (this.probes.size >= 1000)
			this.probes.delete(this.probes.keys().next().value ?? "");
		this.probes.set(key, result);
		return result;
	}
	async enrich(
		models: RouteModel[],
		refresh = false,
		route?: ApiRouteCredential,
		forceProbes = false,
	): Promise<RouteModel[]> {
		return mapWithConcurrency(models, 3, async (model) => {
						let levels = await this.reasoning(model.slug, refresh);
						let extra: Record<string, unknown> = {};
						if (route?.enabled && route.probeCapabilities) {
							const probed = await this.probe(
								route,
								model.slug,
								levels,
								forceProbes,
							);
							levels = probed.levels;
							extra = {
								service_tiers: probed.tiers.map((id) => ({
									id: id === "fast" ? "priority" : id,
									name: id === "fast" ? "Fast" : "Ultrafast",
									description:
										"Verified by an API probe; runtime capacity can still downgrade processing.",
								})),
								default_service_tier: "default",
								additional_speed_tiers: probed.tiers,
								capability_probe_status: probed.status,
								capability_checked_at: probed.at,
							};
						}
						// Ultra is a native orchestration mode. Codex resolves it to this
						// supported wire effort; it is not an API entitlement named "ultra".
						const multiAgentEffort =
							["max", "xhigh", "high"].find((level) =>
								levels.includes(level),
							) ?? null;
						const nativeLevels = multiAgentEffort
							? [...levels, "ultra"]
							: levels;
						return {
							...model,
							...extra,
							multi_agent_reasoning_effort: multiAgentEffort,
							supported_reasoning_levels: nativeLevels.map((effort) => ({
								effort,
								description:
									effort === "ultra"
										? "Proactive multi-agent mode using a supported API reasoning effort"
										: `${effort} reasoning effort`,
							})),
							default_reasoning_level: levels.includes("medium")
								? "medium"
								: (levels[0] ?? null),
						};
		});
	}
}
