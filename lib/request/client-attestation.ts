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
	let parsed: Record<string, unknown> = {};
	if (typeof value === "string") {
		try {
			const candidate = JSON.parse(value) as unknown;
			if (isRecord(candidate)) parsed = candidate;
		} catch {
			// A malformed client value cannot suppress the proxy-owned attestation.
		}
	}
	removeClientAttestationMetadata(parsed);
	Object.assign(parsed, TURN_ATTESTATION[attestation]);
	return JSON.stringify(parsed);
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
