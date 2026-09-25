import { isRecord } from "../utils.js";

export interface StreamCompletion {
	success: boolean;
	errorCode: string | null;
	missingTerminal: boolean;
}

/** Protocol completion, separate from socket delivery. Never retain output or error messages. */
export class ResponseOutcome {
	private terminal: "completed" | "failed" | "incomplete" | "cancelled" | undefined;
	rejection: { error: { code?: string; param?: string } } | undefined;

	constructor(private readonly requireTerminal: boolean) {}

	observe(value: unknown): void {
		if (!isRecord(value)) return;
		const type = value.type ?? (value.object === "response" && typeof value.status === "string" ? `response.${value.status}` : undefined);
		if (type === "response.completed") {
			if (!this.terminal) this.terminal = "completed";
			return;
		}
		const failure = type === "response.failed" || type === "error";
		if (!failure && type !== "response.incomplete" && type !== "response.cancelled") return;
		this.terminal = failure ? "failed" : type === "response.incomplete" ? "incomplete" : "cancelled";
		const response = isRecord(value.response) ? value.response : value;
		const error = isRecord(response.error) ? response.error : type === "error" ? value : undefined;
		if (error) {
			const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(v) ? v : undefined;
			this.rejection = { error: { code: safe(error.code), param: safe(error.param) } };
		}
	}

	finish(): StreamCompletion {
		const missingTerminal = this.requireTerminal && !this.terminal;
		const success = !missingTerminal && (!this.terminal || this.terminal === "completed");
		return {
			success,
			missingTerminal,
			errorCode: success ? null : missingTerminal ? "upstream_missing_terminal" : `upstream_response_${this.terminal}`,
		};
	}
}
