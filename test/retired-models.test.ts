import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	MODEL_PROFILES,
	QUOTA_PROBE_MODEL_CHAIN,
	RETIRED_MODEL_REPLACEMENTS,
	getModelProfile,
	resolveNormalizedModel,
} from "../lib/request/helpers/model-map.js";
import {
	DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
	resolveUnsupportedCodexFallbackModel,
} from "../lib/request/error-classification.js";
import { getUsageModelPricing } from "../lib/usage/pricing.js";

/**
 * Retired models: every id OpenAI's deprecations page lists as shut down, and
 * every slug the upstream Codex catalog removed (`gpt-5.4` carries
 * `retirement_at: 2026-08-31`). A retired id must never be sent under its own
 * name again, must still resolve (old configs keep working), and lib and the
 * wrapper (scripts/codex.js, which cannot import lib) must agree on where it
 * goes.
 */
process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const wrapper = (await import("../scripts/codex.js")) as {
	normalizeRequestedModel: (model: string) => string;
	resolveModelFamilyForStatus: (model: string) => string | null;
	WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN: Record<string, string[]>;
	RETIRED_MODEL_REPLACEMENTS: Record<string, string>;
};
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;

const RETIRED = Object.keys(RETIRED_MODEL_REPLACEMENTS);
const LIVE = new Set(Object.keys(MODEL_PROFILES));

describe("retired models", () => {
	it("covers every id OpenAI or upstream Codex retired", () => {
		// Pinned so a later edit cannot quietly drop one back into routing.
		expect(RETIRED.sort()).toEqual(
			[
				"codex-max",
				"codex-mini-latest",
				"gpt-5-chat-latest",
				"gpt-5-codex",
				"gpt-5-codex-mini",
				"gpt-5-mini",
				"gpt-5-nano",
				"gpt-5.1",
				"gpt-5.1-chat-latest",
				"gpt-5.1-codex",
				"gpt-5.1-codex-max",
				"gpt-5.1-codex-mini",
				"gpt-5.2",
				"gpt-5.2-chat-latest",
				"gpt-5.2-codex",
				"gpt-5.2-pro",
				"gpt-5.3-chat-latest",
				"gpt-5.3-codex",
				"gpt-5.3-codex-spark",
				"gpt-5.4",
				"gpt-5.4-mini",
				"gpt-5.4-nano",
				"gpt-5.4-pro",
			].sort(),
		);
	});

	it("keeps no profile for a retired id, and only live replacements", () => {
		for (const [retired, replacement] of Object.entries(
			RETIRED_MODEL_REPLACEMENTS,
		)) {
			expect(LIVE.has(retired), `${retired} still has a profile`).toBe(false);
			expect(LIVE.has(replacement), `${retired} -> ${replacement}`).toBe(true);
		}
	});

	it.each(RETIRED)("resolves `%s` (and its effort variants) to its replacement", (id) => {
		const replacement = RETIRED_MODEL_REPLACEMENTS[id];
		for (const variant of [id, `${id}-high`, `openai/${id}`]) {
			expect(resolveNormalizedModel(variant), variant).toBe(replacement);
		}
		expect(getModelProfile(id).normalizedModel).toBe(replacement);
	});

	it("routes any unlisted codex id to Sol, and codex minis to Terra", () => {
		expect(resolveNormalizedModel("gpt-6-codex")).toBe("gpt-5.6-sol");
		expect(resolveNormalizedModel("gpt-5.7-codex-mini")).toBe("gpt-5.6-terra");
	});

	it("never probes a retired model", () => {
		for (const model of QUOTA_PROBE_MODEL_CHAIN) {
			expect(RETIRED, model).not.toContain(model);
			expect(LIVE.has(model), model).toBe(true);
		}
	});

	it("gives every retired id one fallback hop to its replacement", () => {
		const body = {
			error: {
				message:
					"'gpt-5.4' model is not supported when using codex with a chatgpt account",
			},
		};
		for (const [retired, replacement] of Object.entries(
			RETIRED_MODEL_REPLACEMENTS,
		)) {
			expect(DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[retired]).toEqual([
				replacement,
			]);
			expect(
				resolveUnsupportedCodexFallbackModel({
					requestedModel: retired,
					errorBody: body,
					fallbackOnUnsupportedCodexModel: true,
					fallbackToGpt52OnUnsupportedGpt53: true,
				}),
				retired,
			).toBe(replacement);
		}
	});

	it("never falls back onto a retired model", () => {
		for (const [from, targets] of Object.entries(
			DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN,
		)) {
			for (const target of targets) {
				expect(RETIRED, `${from} -> ${target}`).not.toContain(target);
			}
		}
	});

	it("keeps pricing for retired ids that already had a rate", () => {
		// Historical ledger rows keep the model string they were recorded under;
		// dropping these rows would turn that usage into unknown cost and make a
		// maxCostUsd budget fail closed for the whole window.
		for (const model of ["gpt-5-codex", "gpt-5.1-codex", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4"]) {
			expect(getUsageModelPricing(model), model).not.toBeNull();
		}
	});

	it("lists no retired model in either config template", () => {
		for (const file of ["config/codex-modern.json", "config/codex-legacy.json"]) {
			const models = Object.keys(
				(
					JSON.parse(readFileSync(file, "utf8")) as {
						provider: { openai: { models: Record<string, unknown> } };
					}
				).provider.openai.models,
			);
			for (const model of models) {
				// Legacy entries are `<model>-<effort>`; strip the effort to get the id.
				const id = model.replace(/-(none|minimal|low|medium|high|xhigh|max|ultra)$/, "");
				expect(LIVE.has(id), `${file}: ${model} is not a live model`).toBe(true);
			}
		}
	});
});

describe("retired models: wrapper parity", () => {
	it("carries the same replacement table as lib", () => {
		expect(wrapper.RETIRED_MODEL_REPLACEMENTS).toEqual(RETIRED_MODEL_REPLACEMENTS);
	});

	it.each(RETIRED)("normalizes `%s` the same as lib", (id) => {
		for (const variant of [id, `${id}-xhigh`, `openai/${id}`]) {
			expect(wrapper.normalizeRequestedModel(variant), variant).toBe(
				resolveNormalizedModel(variant),
			);
		}
	});

	it.each(RETIRED)("carries lib's fallback row for `%s`", (id) => {
		expect(wrapper.WRAPPER_UNSUPPORTED_MODEL_FALLBACK_CHAIN[id]).toEqual(
			DEFAULT_UNSUPPORTED_CODEX_FALLBACK_CHAIN[id],
		);
	});

	it("reports the replacement's family for a retired general id", () => {
		// Codex ids stay in the `codex` status bucket (unchanged); every retired
		// general id now runs on a model in the gpt-5.2 prompt family.
		for (const id of ["gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.4-mini", "gpt-5-mini"]) {
			expect(wrapper.resolveModelFamilyForStatus(id), id).toBe(
				getModelProfile(id).promptFamily,
			);
		}
	});
});
