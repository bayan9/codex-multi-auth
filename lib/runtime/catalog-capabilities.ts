import { isRecord } from "../utils.js";
import type { CatalogModel } from "./account-model-catalog.js";
const contextLimits = ["context_window", "max_context_window", "auto_compact_token_limit"] as const;
const canonicalTier = (value: string) => value === "priority" ? "fast" : value;
const tierIds = (model: CatalogModel) => Array.isArray(model.service_tiers)
    ? model.service_tiers.filter(tier => isRecord(tier) && typeof tier.id === "string")
    : [];
/**
 * Combine selectable settings so every advertised (effort, tier) pair is served
 * by one account: efforts are unioned, tiers intersected. An effort then comes
 * from some account, and every account offering the model supports every tier.
 */
export function mergeCatalogModel(a: CatalogModel, b: CatalogModel): CatalogModel {
    const result = { ...a };
    const efforts = new Map<string, unknown>();
    for (const model of [a, b])
        for (const option of Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []) {
            if (isRecord(option) && typeof option.effort === "string")
                efforts.set(option.effort, option);
        }
    if (efforts.size)
        result.supported_reasoning_levels = [...efforts.values()];
    if (Array.isArray(a.service_tiers) || Array.isArray(b.service_tiers)) {
        const shared = new Set(tierIds(b).map(tier => canonicalTier((tier as { id: string }).id)));
        result.service_tiers = tierIds(a).filter(tier => shared.has(canonicalTier((tier as { id: string }).id)));
    }
    return clampCatalogContext(result, b);
}
export function clampCatalogContext(a: CatalogModel, b: CatalogModel): CatalogModel {
    const result = { ...a };
    // Context is not a selectable setting sent on requests. Advertise the safe
    // shared limit instead of letting the first account overstate another's limit.
    for (const field of contextLimits) {
        if (typeof a[field] === "number" && typeof b[field] === "number")
            result[field] = Math.min(a[field], b[field]);
        else
            delete result[field];
    }
    return result;
}
export function supportsCatalogSettings(model: CatalogModel, effort?: string, tier?: string): boolean {
    if (effort && (!Array.isArray(model.supported_reasoning_levels) || !model.supported_reasoning_levels.some(level => isRecord(level) && level.effort === effort)))
        return false;
    if (tier && tier !== "default" && tier !== "auto" && (!Array.isArray(model.service_tiers) || !model.service_tiers.some(level => isRecord(level) && typeof level.id === "string" && canonicalTier(level.id) === canonicalTier(tier))))
        return false;
    return true;
}
