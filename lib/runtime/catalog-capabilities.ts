import { isRecord } from "../utils.js";
import type { CatalogModel } from "./account-model-catalog.js";
const contextLimits = ["context_window", "max_context_window", "auto_compact_token_limit"] as const;
const canonicalTier = (value: string) => value === "priority" ? "fast" : value;
/** Combine selectable settings; routing must check the complete requested pair. */
export function mergeCatalogModel(a: CatalogModel, b: CatalogModel): CatalogModel {
    const result = { ...a };
    for (const [field, key] of [["supported_reasoning_levels", "effort"], ["service_tiers", "id"]] as const) {
        const options = new Map<string, unknown>();
        for (const model of [a, b])
            for (const option of Array.isArray(model[field]) ? model[field] : []) {
                if (isRecord(option) && typeof option[key] === "string")
                    options.set(option[key], option);
            }
        if (options.size)
            result[field] = [...options.values()];
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
