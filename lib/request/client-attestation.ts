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
	commaBefore: number | null;
	commaAfter: number | null;
}

interface JsonObjectScan {
	closeIndex: number;
	entries: JsonObjectEntry[];
	hasUnrewrittenEntry: boolean;
	overflowed: boolean;
}

const MAX_REWRITTEN_MEMBER_MATCHES = 1_024;

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

function jsonStringHasEscape(text: string, start: number, end: number): boolean {
	for (let cursor = start + 1; cursor < end - 1; cursor += 1) {
		if (text.charCodeAt(cursor) === 92) return true;
	}
	return false;
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

function decodedJsonStringEquals(
	text: string,
	start: number,
	end: number,
	expected: string,
): boolean {
	let expectedIndex = 0;
	for (let cursor = start + 1; cursor < end - 1; cursor += 1) {
		let charCode = text.charCodeAt(cursor);
		if (charCode === 92) {
			cursor += 1;
			const escape = text.charAt(cursor);
			if (escape === "u") {
				charCode = 0;
				for (let offset = 1; offset <= 4; offset += 1) {
					const digit = text.charCodeAt(cursor + offset);
					charCode = charCode * 16 + (digit >= 97 ? digit - 87 : digit >= 65 ? digit - 55 : digit - 48);
				}
				cursor += 4;
			} else if (escape === "b") charCode = 8;
			else if (escape === "f") charCode = 12;
			else if (escape === "n") charCode = 10;
			else if (escape === "r") charCode = 13;
			else if (escape === "t") charCode = 9;
			else charCode = escape.charCodeAt(0);
		}
		if (charCode !== expected.charCodeAt(expectedIndex)) return false;
		expectedIndex += 1;
	}
	return expectedIndex === expected.length;
}

function scanJsonObject(
	text: string,
	rewrittenKeys: Set<string>,
	start = 0,
): JsonObjectScan | null {
	let cursor = skipJsonWhitespace(text, start);
	if (text.charAt(cursor) !== "{") return null;
	cursor += 1;
	let commaBefore: number | null = null;
	let hasUnrewrittenEntry = false;
	let overflowed = false;
	const entries: JsonObjectEntry[] = [];
	const canonicalKeys = [...rewrittenKeys].map((key) => ({
		key,
		source: JSON.stringify(key),
	}));
	for (;;) {
		cursor = skipJsonWhitespace(text, cursor);
		if (text.charAt(cursor) === "}") return { closeIndex: cursor, entries, hasUnrewrittenEntry, overflowed };
		if (text.charAt(cursor) !== '"') return null;
		const entryStart = cursor;
		const keyStart = cursor;
		const keyEnd = jsonStringEnd(text, cursor);
		let key: string | undefined;
		const escapedKey = jsonStringHasEscape(text, keyStart, keyEnd);
		for (const candidate of canonicalKeys) {
			const matches =
				escapedKey
					? decodedJsonStringEquals(text, keyStart, keyEnd, candidate.key)
					: candidate.source.length === keyEnd - keyStart &&
						text.startsWith(candidate.source, keyStart);
			if (matches) {
				key = candidate.key;
				break;
			}
		}
		cursor = skipJsonWhitespace(text, keyEnd);
		if (text.charAt(cursor) !== ":") return null;
		const valueStart = skipJsonWhitespace(text, cursor + 1);
		const valueEnd = jsonValueEnd(text, valueStart);
		cursor = skipJsonWhitespace(text, valueEnd);
		const commaAfter = text.charAt(cursor) === "," ? cursor : null;
		if (key) {
			if (entries.length >= MAX_REWRITTEN_MEMBER_MATCHES) overflowed = true;
			else entries.push({
				key,
				start: entryStart,
				end: valueEnd,
				valueStart,
				valueEnd,
				commaBefore,
				commaAfter,
			});
		} else {
			hasUnrewrittenEntry = true;
		}
		if (commaAfter === null) {
			if (text.charAt(cursor) === "}") return { closeIndex: cursor, entries, hasUnrewrittenEntry, overflowed };
			return null;
		}
		commaBefore = commaAfter;
		cursor += 1;
	}
}

function removeEntryRanges(text: string, scan: JsonObjectScan): string {
	const entries = [...scan.entries].sort((left, right) => left.start - right.start);
	const ranges: Array<{ start: number; end: number }> = [];
	let trailingStart = entries.length;
	if (entries.at(-1)?.commaAfter === null) {
		trailingStart = entries.length - 1;
		while (
			trailingStart > 0 &&
			entries[trailingStart]?.commaBefore ===
				entries[trailingStart - 1]?.commaAfter
		) {
			trailingStart -= 1;
		}
	}
	for (let index = 0; index < trailingStart; index += 1) {
		const entry = entries[index];
		if (entry) {
			ranges.push({ start: entry.start, end: (entry.commaAfter ?? entry.end - 1) + 1 });
		}
	}
	const firstTrailing = entries[trailingStart];
	const lastEntry = entries.at(-1);
	if (firstTrailing && lastEntry) {
		ranges.push({
			start: firstTrailing.commaBefore ?? firstTrailing.start,
			end: lastEntry.end,
		});
	}
	const chunks: string[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) chunks.push(text.slice(cursor, range.start));
		cursor = range.end;
	}
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

function rewriteJsonObject(
	text: string,
	body: Record<string, unknown>,
	rewrittenKeys: Set<string>,
	scan = scanJsonObject(text, rewrittenKeys),
	clientMetadataScan?: JsonObjectScan,
): string {
	const serializedEntries: string[] = [];
	const serializedKeys = new Set<string>();
	const appendKey = (key: string): void => {
		if (serializedKeys.has(key) || !Object.hasOwn(body, key)) return;
		serializedKeys.add(key);
		const value = body[key];
		let serializedValue: string;
		if (key === "client_metadata" && isRecord(value)) {
			let original: JsonObjectEntry | undefined;
			for (const entry of scan?.entries ?? []) {
				if (entry.key === key) original = entry;
			}
			const originalValue = original
				? text.slice(original.valueStart, original.valueEnd)
				: "{}";
			serializedValue = rewriteJsonObject(
				originalValue,
				value,
				TURN_ATTESTATION_KEYS,
				clientMetadataScan,
			);
		} else {
			serializedValue = JSON.stringify(value);
		}
		serializedEntries.push(`${JSON.stringify(key)}:${serializedValue}`);
	};
	for (const entry of scan?.entries ?? []) appendKey(entry.key);
	for (const key of rewrittenKeys) appendKey(key);
	if (!scan) return `{${serializedEntries.join(",")}}`;
	const preserved = removeEntryRanges(text, scan);
	const closeIndex = scan.closeIndex - (text.length - preserved.length);
	const beforeClose = preserved.slice(0, closeIndex);
	const separator = scan.hasUnrewrittenEntry ? "," : "";
	return `${beforeClose}${separator}${serializedEntries.join(",")}${preserved.slice(closeIndex)}`;
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
		if (!isRecord(body)) return null;
		const scan = scanJsonObject(text, rewrittenKeys);
		if (!scan || scan.overflowed) return null;
		let clientMetadataScan: JsonObjectScan | undefined;
		if (rewrittenKeys.has("client_metadata") && isRecord(body.client_metadata)) {
			let clientMetadataEntry: JsonObjectEntry | undefined;
			for (const candidate of scan.entries) {
				if (candidate.key === "client_metadata") clientMetadataEntry = candidate;
			}
			if (!clientMetadataEntry) return null;
			clientMetadataScan = scanJsonObject(
				text.slice(clientMetadataEntry.valueStart, clientMetadataEntry.valueEnd),
				TURN_ATTESTATION_KEYS,
			) ?? undefined;
			if (!clientMetadataScan || clientMetadataScan.overflowed) return null;
		}
		return {
			body,
			serialize: () => Buffer.from(
				rewriteJsonObject(text, body, rewrittenKeys, scan, clientMetadataScan),
			),
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
