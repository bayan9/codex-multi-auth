import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY = "1";
const wrapper = (await import("../scripts/codex.js")) as {
	isRuntimeRotationProxyEnabled: (
		args: string[],
		env: NodeJS.ProcessEnv,
	) => Promise<boolean>;
};
delete process.env.CODEX_MULTI_AUTH_WRAPPER_IMPORT_ONLY;
it("uses the native app binding instead of overlaying a custom provider", async () => {
	const home = await mkdtemp(join(tmpdir(), "native-wrapper-"));
	try {
		await writeFile(
			join(home, "config.toml"),
			'# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:43210"\n# codex-multi-auth native provider end\n',
		);
		expect(
			await wrapper.isRuntimeRotationProxyEnabled(["app"], {
				CODEX_HOME: home,
				CODEX_MULTI_AUTH_RUNTIME_ROTATION_PROXY: "1",
			}),
		).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
