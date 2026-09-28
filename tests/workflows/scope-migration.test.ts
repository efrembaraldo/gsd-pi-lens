import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Scope-migration regression guard (S01).
 *
 * The fork renamed the host SDK scope `@earendil-works/*` → `@gsd/*`. This
 * guard pins the migrate-off-scope baseline: no file in the tracked tree may
 * carry an `/earendil/i` reference except the five documented whitelisted files:
 *   - CHANGELOG.md                  — historical changelog body (upstream prose)
 *   - HISTORY.md                    — historical release-history record (upstream prose)
 *   - tests/workflows/fork-disclosure.test.ts — `expect(...).not.toContain("earendil-works")`
 *     absence assertion (S02 slice disclosure check), not real usage.
 *   - tests/workflows/fork-workflows.test.ts — `expect(...).not.toContain("earendil-works")`
 *     assertions, i.e. absence assertions, not real usage.
 *   - tests/scripts/m004-s02-scope-validation.mjs — M004/S02 persistent
 *     regression script (sibling to m004-s01-strategy-validation.mjs); it
 *     literal-string-tests the legacy scope (`@earendil-works`) by design and
 *     therefore belongs to the same "absence-of-real-usage" whitelist class
 *     as the two fork-workflows.test.ts assertions.
 *
 * The walk is an `fs` walk (per the S01 contract) over the working tree with
 * git/build/noise trees excluded by name. Reintroducing a scope reference in
 * any tracked source, test, config, or workflow file elsewhere reddens this
 * test (mutation-proof).
 *
 * Deliberate non-goal: gitignored build outputs `dist/` and `grammars/` are not
 * part of the tracked tree this guard protects; they carry no scope reference
 * in the current tree and are left out of scope by the documented exclusion
 * set. `vendor/` (also gitignored) is enumerated here as an exclusion because
 * the S01 contract names it explicitly — a regenerated vendored copy could
 * otherwise import a mismatched scope and poison the walk forever.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** Directory names skipped by the sweep (build trees, git metadata, vendored deps). */
const EXCLUDED_DIR_NAMES = new Set<string>([
	"node_modules",
	".git",
	".gsd",
	".gsd-id",
	".gsd-sessions",
	".gsd-state",
	".pack-backup",
	"vendor",
]);

/** Any reference to the legacy scope, case-insensitive (broader than `earendil-works`). */
const SCOPE_REFERENCE = /earendil/i;

/** Repo-relative POSIX path of this guard file, which must name the scope it forbids. */
const SELF_RELATIVE = relative(REPO_ROOT, fileURLToPath(import.meta.url))
	.split(sep)
	.join("/");

/**
 * Repo-relative POSIX-style paths of regular files reachable from REPO_ROOT,
 * skipping EXCLUDED_DIR_NAMES at every level and never following symlinks
 * (a symlink to a directory would otherwise re-enter the tree / loop).
 */
function walkRepo(): string[] {
	const results: string[] = [];
	const visit = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
			const abs = join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				visit(abs, rel);
			} else if (entry.isFile()) {
				results.push(rel);
			}
			// Dirents that are neither directories nor regular files (symlinks,
			// sockets, fifos) are deliberately not read.
		}
	};
	visit(REPO_ROOT, "");
	return results;
}

/** Subset of `paths` whose UTF-8 content matches `pattern`. Unreadable files are not matches. */
function filesMatching(pattern: RegExp, paths: string[]): string[] {
	const hits: string[] = [];
	for (const rel of paths) {
		let content: string;
		try {
			content = readFileSync(join(REPO_ROOT, rel), "utf8");
		} catch {
			continue;
		}
		if (pattern.test(content)) hits.push(rel);
	}
	return hits;
}

describe("scope migration baseline (S01)", () => {
	it("contains no legacy scope reference outside the documented whitelist", () => {
		// The guard's own file is excluded from its own match set: a sentinel
		// guard must name the scope it forbids (in comments and messages), so its
		// own bytes are not a "reference elsewhere" — exactly like the
		// fork-workflows.test.ts absence assertions already in the whitelist.
		const hits = filesMatching(SCOPE_REFERENCE, walkRepo())
			.filter((p) => p !== SELF_RELATIVE)
			.sort();
		// HISTORY.md is part of the whitelist on the same footing as CHANGELOG.md:
		// it is a pre-fork release-history document that records contractual events
		// occurring BEFORE the August-September 2026 scope migration to `@gsd/*`.
		// Those historical references to the legacy scope are part of the factual
		// record and must not be retroactively rewritten; the guard protects
		// active source/config/test/workflow files from re-introducing the legacy
		// scope, while pre-fork historical documentation is intentionally out of
		// protection scope. See the docblock at the top of this file for the full
		// rationale and the corresponding CHANGELOG.md whitelist policy.
		const expected = [
			"CHANGELOG.md",
			"HISTORY.md",
			"tests/scripts/m004-s02-scope-validation.mjs",
			"tests/workflows/fork-disclosure.test.ts",
			"tests/workflows/fork-workflows.test.ts",
		].sort();
		expect(hits).toEqual(expected);
	});

	it("walk actually reaches tracked source files (sweep is not vacuously empty)", () => {
		// Mutation-proof: a broken/empty exclusion walk that returned zero files
		// (or only the two whitelisted files) would make the assertion above pass
		// trivially and protect nothing. Pin that the sweep covers the real tree.
		const files = walkRepo();
		expect(files.length).toBeGreaterThan(100);
		expect(files).toContain("index.ts");
		expect(files).toContain("clients/file-utils.ts");
		expect(files).toContain(".github/workflows/ci.yml");
	});
});
