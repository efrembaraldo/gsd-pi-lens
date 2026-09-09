/**
 * MCP `mode=fresh` LSP warm-up honesty (S03/T03) — real end-to-end smoke:
 * spawns the actual server subprocess with `PI_LENS_MCP_FRESH_WARMUP_TIMEOUT_MS=50`
 * (a deliberately aggressive 50ms budget that any cold `typescript-language-server`
 * index pass will exceed), drives `pilens_analyze` with `mode: "fresh"` against a
 * real `.ts` file inside a throwaway workspace, and asserts the LSP honesty signal
 * reports `warmup-timeout` rather than the prior `skipped`/`clean` collapse that
 * produced the cold-0 read-as-clean defect. This is the acceptance proof called
 * out in the S03 slice plan: "mode=fresh attende il warmup configurabile e
 * riporta lsp.status: 'warmup-timeout' su timeout invece di un conteggio 0."
 *
 * The workspace is a tempdir containing the real `clients/mcp/host-shim.ts`
 * (symlinked — git-tracked source per the test-fixture rule) plus a minimal
 * `tsconfig.json` and a `node_modules` symlink back to the repo's installed
 * deps, so `typescript-language-server` can resolve its typescript dep and
 * start indexing. `McpHarness` deliberately refuses `cwd: repoRoot` to keep
 * smoke tests from binding the developer's real workspace IPC endpoint —
 * `analyze-graph.smoke.test.ts` works around this with the same tempdir
 * pattern. `cwd` therefore points at the tempdir, not the repo.
 *
 * Requires `npm run build` first (resolves mcp/server.js next to its source).
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpHarness, repoRoot } from "./harness.js";

describe("MCP mode=fresh LSP warm-up honesty (real spawn)", { retry: 2 }, () => {
	let harness: McpHarness;
	let projectDir: string;
	let targetFile: string;

	beforeAll(() => {
		projectDir = mkdtempSync(path.join(tmpdir(), "pi-lens-fresh-warmup-"));
		// Minimal tsconfig so typescript-language-server has SOMETHING to read —
		// even on a 50ms budget, the absence of a tsconfig would skip the index
		// pass entirely and the warm-up might "succeed" by reporting no files
		// rather than by timing out. We want the cold-spawn path, which requires
		// a real tsconfig.
		writeFileSync(
			path.join(projectDir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
		);
		// Symlink the repo's installed node_modules so typescript-language-server
		// can resolve its typescript dep inside the throwaway workspace. A symlink
		// (not a copy) is the right primitive — copy would drift and not be
		// updated when deps change.
		symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(projectDir, "node_modules"),
		);
		// Symlink the real `clients/mcp/host-shim.ts` (git-tracked source — see
		// the test-fixture rule: never .gitignore/gitignored local paths). A
		// `.ts` file is what `LSPService.supportsLSP` keys off to return true.
		targetFile = path.join(projectDir, "host-shim.ts");
		symlinkSync(
			path.join(repoRoot, "clients", "mcp", "host-shim.ts"),
			targetFile,
		);

		harness = new McpHarness({
			cwd: projectDir,
			env: {
				// Deliberately aggressive budget: a cold typescript-language-server
				// index will take seconds, so any real warm-up call must breach it.
				// The env var is read at call time on the fresh worker (see
				// `mcpFreshWarmupTimeoutMs()` in clients/mcp/analyze.ts).
				PI_LENS_MCP_FRESH_WARMUP_TIMEOUT_MS: "50",
			},
		});
	});

	afterAll(() => {
		harness.dispose();
		try {
			rmSync(projectDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch {
			// OS reclaims the temp dir eventually.
		}
	});

	it("completes the initialize handshake before the warm-up probe", async () => {
		const res = await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-test", version: "0" },
		});
		expect(
			(res.result as { serverInfo: { name: string } }).serverInfo.name,
		).toBe("pi-lens-mcp");
		harness.notify("notifications/initialized");
	}, 25_000);

	it(
		"reports lsp.status: 'warmup-timeout' on mode=fresh when PI_LENS_MCP_FRESH_WARMUP_TIMEOUT_MS elapses",
		async () => {
			// `mode: "fresh"` forks a fresh subprocess that reads the env we just
			// set; the 50ms budget is well below a cold typescript-language-server
			// index pass, so the `LSPService.touchFile` warm-up call MUST return
			// `undefined` and the warm-up outcome MUST classify as `warmup-timeout`.
			const res = await harness.request(
				2,
				"tools/call",
				{
					name: "pilens_analyze",
					arguments: { file: targetFile, mode: "fresh" },
				},
				// The fresh worker spawn + handshake + warm-up probe must complete
				// inside this bound; the 50ms warm-up itself is what we're proving
				// fails fast, but we leave headroom for the spawn + stdio round-trip.
				60_000,
			);
			const result = res.result as {
				content: { type: string; text: string }[];
				isError?: boolean;
			};
			if (result.isError) {
				throw new Error(
					`pilens_analyze returned isError; raw payload for debugging:\n${JSON.stringify(
						res,
						null,
						2,
					)}`,
				);
			}
			const text = result.content[0].text;
			// The summary string is rendered by `formatAnalyze()` in mcp/server.ts
			// and embeds `lsp ${count} (${status}, ${durationMs}ms)`. For a real
			// cold-spawn warm-up breach the count is `0`, the status is the new
			// honest `warmup-timeout`, and the duration reflects the elapsed
			// budget. Match both forms: containment on the substring AND a
			// structured regex for the parens-shaped token, so a regression that
			// loses the parens or the unit still fails the test.
			expect(text).toContain("[fresh]");
			expect(text).toMatch(/lsp 0 \(warmup-timeout, \d+ms\)/);
			// Also pin the precedent that the prior bug collapsed to: a `0` with
			// `skipped` (or any other non-`warmup-timeout` status). This negative
			// shape guards against future regressions that swallow the warm-up
			// outcome and fall back to the dispatch runner's verdict.
			expect(text).not.toMatch(/lsp 0 \(skipped,/);
			expect(text).not.toMatch(/lsp 0 \(clean,/);
		},
		60_000,
	);
});
