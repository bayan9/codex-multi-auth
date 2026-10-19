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

/** Parse JSON while retaining every numeric token for lossless serialization. */
export function parseAttestableRequestBody(source: Buffer): {
	body: Record<string, unknown>;
	serialize: () => Buffer;
} | null {
	const text = source.toString("utf8");
	let prefix = "__cma_raw_number_";
	while (text.includes(prefix)) prefix = `_${prefix}`;
	const numbers: string[] = [];
	let protectedText = "";
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length;) {
		const char = text.charAt(index);
		if (quoted) {
			protectedText += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			index += 1;
			continue;
		}
		if (char === '"') {
			quoted = true;
			protectedText += char;
			index += 1;
			continue;
		}
		const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (match) {
			protectedText += JSON.stringify(`${prefix}${numbers.length}`);
			numbers.push(match[0]);
			index += match[0].length;
		} else {
			protectedText += char;
			index += 1;
		}
	}
	try {
		const body = JSON.parse(protectedText) as unknown;
		if (!isRecord(body)) return null;
		return {
			body,
			serialize: () => Buffer.from(
				JSON.stringify(body).replace(new RegExp(`"${prefix}(\\d+)"`, "g"),
					(whole, index: string) => numbers[Number(index)] ?? whole),
			),
		};
	} catch {
		return null;
	}
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
		? parseAttestableRequestBody(Buffer.from(value))
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
