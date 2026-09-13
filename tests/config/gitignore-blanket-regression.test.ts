import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/**
 * Regression guard for #2250: the GSD upstream extension's
 * `ensureGitignore()` (`~/.gsd/agent/extensions/gsd/gitignore.js`) matches
 * `.vscode/` and `vendor/` as EXACT trimmed-line tokens, finds only the
 * carve-out `.vscode/*` / `vendor/*` form already in this project's
 * `.gitignore`, and APPENDS blanket `.vscode/` and `vendor/` rules. Per
 * git-scm.com/docs/gitignore: "It is not possible to re-include a file if
 * a parent directory of that file is excluded" — so the blanket rule
 * shadows `.vscode/settings.json` and `vendor/grammars/tree-sitter-cue.wasm`
 * and silently breaks ignore-respecting tooling (rg, GitHub code search,
 * plain `grep --exclude-from`) for those files. This test catches the
 * CAUSE (the literal in `.gitignore`), while `gitignore-tracked-shadow.test.ts`
 * catches the EFFECT (the shadowed file in `git check-ignore`).
 *
 * The blanket pattern that triggers the shadow is `dir/` (or `dir`) — the
 * directory-only form. The carve-out form `dir/*` is the only safe way to
 * ignore a directory while re-including specific tracked files. We match
 * any leading-`dir/` or leading-`dir` form so the test trips on a typo
 * (e.g. `.vscode` without the slash, or `vendor/` in a different position).
 *
 * Skips are scoped to the comment block that DOCUMENTS the carve-out:
 * every blanket rule must carry a paired `dir/*` + `!dir/file` immediately
 * below it. Outside that documentation the test fails.
 */
function findBlanketIgnoreRules(): { dir: string; line: number; context: string[] }[] {
	const text = readFileSync(path.join(repoRoot, ".gitignore"), "utf-8");
	const lines = text.split("\n");
	// Matches:
	//   `.vscode/`           — bare-dir form
	//   `.vscode`            — bare-dir form without trailing slash
	// Captures the directory name. Anchored to start-of-line so we never
	// match a path embedded in a comment that references `.vscode/`.
	const blanketRe = /^\.?(vscode|vendor)(\/)?$/;
	const findings: { dir: string; line: number; context: string[] }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		const m = blanketRe.exec(trimmed);
		if (!m) continue;
		// Look ahead 10 lines for the carve-out form `dir/*` + `!dir/...`.
		// If present, the blanket rule is documentation, not data.
		const lookahead = lines.slice(i + 1, i + 11).join("\n");
		const carveOutRe = new RegExp(
			`^${m[1] === "vscode" ? "\\.vscode" : "vendor"}/\\*\\s*$`,
			"m",
		);
		if (carveOutRe.test(lookahead)) continue;
		findings.push({
			dir: m[1] === "vscode" ? ".vscode" : "vendor",
			line: i + 1,
			context: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)),
		});
	}
	return findings;
}

describe(".gitignore has no blanket dir-level ignore that would shadow tracked carve-outs (#2250)", () => {
	it("contains no bare-directory ignore for .vscode/ or vendor/ outside documented carve-out blocks", () => {
		const findings = findBlanketIgnoreRules();
		expect(findings).toEqual([]);
	});
});
