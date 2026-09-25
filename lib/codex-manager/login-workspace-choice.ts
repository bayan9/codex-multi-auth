import {
	isPersonalAccountCandidate,
	type AccountIdCandidate,
} from "../auth/token-utils.js";
import { CodexValidationError } from "../errors.js";
import { select, type MenuItem } from "../ui/select.js";

interface WorkspaceChoiceDeps {
	interactive: boolean;
	select: (items: MenuItem<string>[]) => Promise<string | null>;
}

/** Undefined delegates to the unambiguous default; null means cancel without saving. */
export async function chooseLoginWorkspace(
	candidates: AccountIdCandidate[],
	deps: WorkspaceChoiceDeps = {
		interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
		select: (items) => select(items, {
			message: "Choose the workspace for this account",
			subtitle: "No unique Personal workspace was identified. Choose explicitly before saving.",
			allowEscape: true,
		}),
	},
): Promise<string | undefined | null> {
	if (candidates.length <= 1 || candidates.filter(isPersonalAccountCandidate).length === 1) {
		return undefined;
	}
	if (!deps.interactive) {
		throw new CodexValidationError("Multiple workspaces found without a unique Personal workspace. Run login in an interactive terminal or use login --org <workspace-id>.");
	}
	const choice = await deps.select(candidates.map((candidate) => ({
		label: candidate.label,
		value: candidate.accountId,
	})));
	if (choice === null) return null;
	if (!candidates.some((candidate) => candidate.accountId === choice)) {
		throw new CodexValidationError("Invalid workspace selection. Account was not saved.");
	}
	return choice;
}
