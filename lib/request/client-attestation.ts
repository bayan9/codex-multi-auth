import { isRecord } from "../utils.js";

const TURN_METADATA_HEADER = "x-codex-turn-metadata";
const CLIENT_ATTESTATION_ENV = "CODEX_MULTI_AUTH_CLIENT_ATTESTATION";
const CLIENT_ATTESTATION_METADATA_KEYS = new Set([
	"active_permission_profile",
	"approval_policy",
	"approvals_reviewer",
	"auto_review_enabled",
	"node_repl_auto_review_required",
	"node_repl_disabled",
	"permission_profile",
	"sandbox",
	"sandbox_mode",
	"sandbox_policy",
]);

const TURN_ATTESTATION = {
	positive: {
		sandbox: "seatbelt",
		sandbox_mode: "workspace-write",
		auto_review_enabled: true,
		node_repl_auto_review_required: true,
		node_repl_disabled: false,
	},
	negative: {
		sandbox: "none",
		sandbox_mode: "danger-full-access",
		auto_review_enabled: false,
		node_repl_auto_review_required: false,
		node_repl_disabled: true,
	},
} as const;

type ClientAttestation = keyof typeof TURN_ATTESTATION;

function asciiHeaderValue(value: string): string {
	return value.replace(/[\u007f-\uffff]/g, (char) =>
		`\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const REQUEST_ATTESTATION_KEYS = new Set([
	"client_metadata",
	"model",
	"service_tier",
]);
const TURN_ATTESTATION_KEYS = new Set([
	...CLIENT_ATTESTATION_METADATA_KEYS,
	TURN_METADATA_HEADER,
]);

interface JsonObjectEntry {
	key: string;
	start: number;
	end: number;
	valueStart: number;
	valueEnd: number;
}

function skipJsonWhitespace(text: string, index: number): number {
	while (/\s/.test(text.charAt(index))) index += 1;
	return index;
}

function jsonStringEnd(text: string, index: number): number {
	let escaped = false;
	for (let cursor = index + 1; cursor < text.length; cursor += 1) {
		const char = text.charAt(cursor);
		if (escaped) escaped = false;
		else if (char === "\\") escaped = true;
		else if (char === '"') return cursor + 1;
	}
	return text.length;
}

function jsonValueEnd(text: string, index: number): number {
	if (text.charAt(index) === '"') return jsonStringEnd(text, index);
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let cursor = index; cursor < text.length; cursor += 1) {
		const char = text.charAt(cursor);
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") {
			if (depth === 0) return cursor;
			depth -= 1;
			if (depth === 0) return cursor + 1;
		} else if (char === "," && depth === 0) return cursor;
	}
	return text.length;
}

function jsonObjectEntries(text: string, start = 0): JsonObjectEntry[] | null {
	let cursor = skipJsonWhitespace(text, start);
	if (text.charAt(cursor) !== "{") return null;
	cursor += 1;
	const entries: JsonObjectEntry[] = [];
	for (;;) {
		cursor = skipJsonWhitespace(text, cursor);
		if (text.charAt(cursor) === "}") return entries;
		if (text.charAt(cursor) !== '"') return null;
		const entryStart = cursor;
		const keyEnd = jsonStringEnd(text, cursor);
		let key: unknown;
		try {
			key = JSON.parse(text.slice(cursor, keyEnd));
		} catch {
			return null;
		}
		cursor = skipJsonWhitespace(text, keyEnd);
		if (text.charAt(cursor) !== ":") return null;
		const valueStart = skipJsonWhitespace(text, cursor + 1);
		const valueEnd = jsonValueEnd(text, valueStart);
		entries.push({ key: String(key), start: entryStart, end: valueEnd, valueStart, valueEnd });
		cursor = skipJsonWhitespace(text, valueEnd);
		if (text.charAt(cursor) === "}") return entries;
		if (text.charAt(cursor) !== ",") return null;
		cursor += 1;
	}
}

function rewriteJsonObject(
	text: string,
	body: Record<string, unknown>,
	rewrittenKeys: Set<string>,
): string {
	const entries = jsonObjectEntries(text) ?? [];
	const preserved = entries
		.filter((entry) => !rewrittenKeys.has(entry.key))
		.map((entry) => text.slice(entry.start, entry.end));
	for (const key of Object.keys(body).filter((key) => rewrittenKeys.has(key))) {
		const value = body[key];
		let serializedValue = JSON.stringify(value);
		if (key === "client_metadata" && isRecord(value)) {
			const original = [...entries].reverse().find((entry) => entry.key === key);
			const originalValue = original
				? text.slice(original.valueStart, original.valueEnd)
				: "{}";
			serializedValue = rewriteJsonObject(
				originalValue,
				value,
				new Set([...CLIENT_ATTESTATION_METADATA_KEYS, TURN_METADATA_HEADER]),
			);
		}
		preserved.push(`${JSON.stringify(key)}:${serializedValue}`);
	}
	return `{${preserved.join(",")}}`;
}

function parseAttestableObject(
	source: Buffer,
	rewrittenKeys: Set<string>,
): {
	body: Record<string, unknown>;
	serialize: () => Buffer;
} | null {
	const text = source.toString("utf8");
	try {
		const body = JSON.parse(text) as unknown;
		if (!isRecord(body) || !jsonObjectEntries(text)) return null;
		return {
			body,
			serialize: () => Buffer.from(rewriteJsonObject(text, body, rewrittenKeys)),
		};
	} catch {
		return null;
	}
}

/** Parse a Responses object and retain unrelated JSON source lexemes. */
export function parseAttestableRequestBody(source: Buffer): {
	body: Record<string, unknown>;
	serialize: () => Buffer;
} | null {
	return parseAttestableObject(source, REQUEST_ATTESTATION_KEYS);
}

function clientMetadataAttestation(attestation: ClientAttestation) {
	const value = TURN_ATTESTATION[attestation];
	return {
		sandbox: value.sandbox,
		sandbox_mode: value.sandbox_mode,
		auto_review_enabled: String(value.auto_review_enabled),
		node_repl_auto_review_required: String(
			value.node_repl_auto_review_required,
		),
		node_repl_disabled: String(value.node_repl_disabled),
	};
}

function configuredClientAttestation(): ClientAttestation {
	return process.env[CLIENT_ATTESTATION_ENV]?.trim().toLowerCase() === "negative"
		? "negative"
		: "positive";
}

function removeClientAttestationMetadata(
	record: Record<string, unknown>,
): void {
	for (const key of CLIENT_ATTESTATION_METADATA_KEYS) delete record[key];
}

function attestedTurnMetadata(
	value: unknown,
	attestation: ClientAttestation,
): string {
	const attestable = typeof value === "string"
		? parseAttestableObject(Buffer.from(value), TURN_ATTESTATION_KEYS)
		: null;
	const parsed = attestable?.body ?? {};
	removeClientAttestationMetadata(parsed);
	Object.assign(parsed, TURN_ATTESTATION[attestation]);
	return asciiHeaderValue(attestable?.serialize().toString("utf8") ?? JSON.stringify(parsed));
}

/** Replace the incoming client attestation with the configured value. */
export function applyClientAttestation(
	body: Record<string, unknown>,
	headers: Headers,
): void {
	const attestation = configuredClientAttestation();
	const clientMetadata = isRecord(body.client_metadata)
		? body.client_metadata
		: {};
	body.client_metadata = clientMetadata;
	removeClientAttestationMetadata(clientMetadata);
	Object.assign(clientMetadata, clientMetadataAttestation(attestation));
	clientMetadata[TURN_METADATA_HEADER] = attestedTurnMetadata(
		clientMetadata[TURN_METADATA_HEADER],
		attestation,
	);
	headers.set(
		TURN_METADATA_HEADER,
		attestedTurnMetadata(headers.get(TURN_METADATA_HEADER), attestation),
	);
}
