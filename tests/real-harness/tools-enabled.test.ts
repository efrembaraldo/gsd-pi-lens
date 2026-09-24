import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../../clients/tool-config.js";
import {
	pollLensLog,
	REAL_PI_AVAILABLE,
	REAL_HOST_FORWARDS_EXTENSION_FLAGS,
	withRealPi,
} from "../support/real-pi-harness.js";

// Pi-surface entries of the canonical registry (clients/tool-config.ts), the
// one source of truth for the model-facing tool roster (#2800).
const EXPECTED_PI_TOOLS: string[] = TOOL_REGISTRY.flatMap((tool) =>
	tool.piName ? [tool.piName] : [],
);

type WireTool = {
	name: string;
	descriptionBytes: number;
	schemaBytes: number;
	surfaceBytes: number;
};

function latestTools(pi: {
	providerObservations(): ReadonlyArray<Record<string, unknown>>;
}): WireTool[] {
	const tools = pi.providerObservations().at(-1)?.tools;
	return (Array.isArray(tools) ? tools : []) as WireTool[];
}

// flake-shape: real-process-spawn — these assertions require pi to load the built extension and report the provider payload across the process boundary
// PI_LENS_TEST_MODE="0" opts this scenario's pi child out of vitest-inherited
// test mode: its assertions read real sessionstart.log/extension.log rows, and
// every NDJSON logger is a no-op under isTestMode(). Other scenarios keep the
// harness default.
describe.skipIf(!REAL_PI_AVAILABLE)("real pi RPC: tools.<name>.enabled", () => {
	it("omits a project-disabled tool from pi's wire roster and records it once", async () => {
		await withRealPi(
			{
				fixture: "tools-disabled",
				script: "script.json",
				args: ["--no-lazy-tools"],
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("report the tool roster");
				await pi.awaitAssistantTurn();
				const tools = latestTools(pi).filter((tool) =>
					EXPECTED_PI_TOOLS.includes(tool.name),
				);
				const names = tools.map((tool) => tool.name);
				expect(names).not.toContain("ast_grep_replace");
				expect(names.sort()).toEqual(
					EXPECTED_PI_TOOLS.filter(
						(name) => name !== "ast_grep_replace",
					).sort(),
				);
				const disabledLines = await pollLensLog(
					() =>
						pi.lens
							.sessionStartLog()
							.filter((line) =>
								line.includes(
									"session_start: disabled tools = ast_grep_replace",
								),
							),
					(lines) => lines.length > 0,
				);
				expect(disabledLines).toHaveLength(1);
				for (const tool of tools) {
					expect(tool.surfaceBytes).toBe(
						tool.descriptionBytes + tool.schemaBytes,
					);
				}
			},
		);
	}, 60_000);

	it("keeps the activation loader registered and emits its config diagnostic once", async () => {
		await withRealPi(
			{
				fixture: "loader-disabled",
				script: "script.json",
				env: { PI_LENS_TEST_MODE: "0" },
			},
			async (pi) => {
				await pi.prompt("report the loader roster");
				await pi.awaitAssistantTurn();
				expect(
					latestTools(pi)
						.filter((tool) => EXPECTED_PI_TOOLS.includes(tool.name))
						.map((tool) => tool.name),
				).toContain("pi_lens_activate_tools");
				const diagnostics = await pollLensLog(
					() =>
						pi.lens
							.extensionLog()
							.filter((row) =>
								String(row.message ?? "").includes("PILENS_CFG_0009"),
							),
					(rows) => rows.length > 0,
				);
				expect(diagnostics).toHaveLength(1);
			},
		);
	}, 60_000);

	// The precondition IS the `--no-tool` CLI flag, and gsd rejects every
	// extension flag on its argv (see REAL_HOST_FORWARDS_EXTENSION_FLAGS).
	// No config spelling is equivalent: tool enablement resolves
	// CLI > project > global, so only the CLI channel can beat the project
	// config this fixture enables. Skipped, not weakened.
	it.skipIf(!REAL_HOST_FORWARDS_EXTENSION_FLAGS)(
		"lets --no-tool win over a project config that enables the tool [skipped on gsd: host rejects extension CLI flags]",
		async () => {
			await withRealPi(
				{
					fixture: "cli-no-tool",
					script: "script.json",
					args: ["--no-lazy-tools", "--no-tool=lsp_navigation"],
					env: { PI_LENS_TEST_MODE: "0" },
				},
				async (pi) => {
					await pi.prompt("report the CLI roster");
					await pi.awaitAssistantTurn();
					expect(
						latestTools(pi)
							.filter((tool) => EXPECTED_PI_TOOLS.includes(tool.name))
							.map((tool) => tool.name),
					).not.toContain("lsp_navigation");
				},
			);
		},
		60_000,
	);
});
