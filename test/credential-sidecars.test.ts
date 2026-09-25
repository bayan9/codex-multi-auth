import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCredentialSidecars } from "../lib/storage/credential-sidecars.js";
import { withFileTransactionLock } from "../lib/storage/file-lock.js";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "sidecars-"));
	vi.stubEnv("CODEX_MULTI_AUTH_DIR", dir);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await fs.rm(dir, { recursive: true, force: true });
});

it.each(["reset-credits.json", "api-capability-probes.json", "api-routes.json"])(
	"waits for an in-flight %s writer so its old state cannot reappear after the reset",
	async (name) => {
		const path = join(dir, name);
		await fs.writeFile(path, '{"policy":"last-resort"}');
		const rm = vi.spyOn(fs, "rm");
		const removed = () => rm.mock.calls.some(([target]) => String(target) === path);
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const inside = new Promise<void>((resolve) => { entered = resolve; });
		// A writer that read the old state under the lock and renames it back later.
		const writer = withFileTransactionLock(path, async () => {
			entered();
			await gate;
			await fs.writeFile(path, '{"policy":"last-resort"}');
		});
		await inside;
		const cleared = clearCredentialSidecars();
		// Let the clear run up to the lock it needs; it must not have deleted yet.
		// (For the later files, the earlier api-routes.json deletion proves the clear got this far.)
		if (name !== "api-routes.json") await vi.waitFor(() => expect(rm.mock.calls.some(([target]) => String(target).endsWith("api-routes.json"))).toBe(true));
		for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
		expect(removed()).toBe(false);
		release();
		await writer;
		await cleared;
		expect(removed()).toBe(true);
		await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	},
);
