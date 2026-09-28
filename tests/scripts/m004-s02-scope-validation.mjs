#!/usr/bin/env node
// Persistent regression script for M004/S02 — scope `@gsd/*` invariants.
//
// This script is the durable, machine-checkable rephrasing of the slice's
// acceptance criterion. The original acceptance is a single `git grep`
// pathspec query: it is correct but easy to typo, easy to silently lose the
// parallel `package.json` checks, and impossible to re-run from CI without
// re-encoding it. Persisting it as a versioned regression script — siblings
// to `m004-s01-strategy-validation.mjs` and `m004-s01-strictness-validation.mjs`
// — keeps every invariant of the @gsd/* scope migration locked-down, so that
// a future upstream re-sync that re-introduces `@earendil-works/*` in any of
// the surfaces below reds this script instead of silently corrupting the
// fork-only baseline.
//
// Style mirrors `tests/scripts/m004-s01-strategy-validation.mjs`: shebang
// header, ESM, builtin-only imports, `fail(msg)` discriminator, terminal
// `console.log` on success.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(msg) {
	// Discriminating stderr key so CI / orchestrators can route on the exact
	// invariant that broke (rather than scraping a free-form string).
	console.error("FAIL [" + msg.key + "]: " + msg.detail);
	process.exit(1);
}

function ok(label, detail) {
	console.log("  PASS " + label + (detail ? " — " + detail : ""));
}

// ---------------------------------------------------------------------------
// (a) Acceptance grep verbatim — the slice's primary check, replayed
//     character-for-character. `git grep` exits 1 when no match is found;
//     paired with empty stdout, that is the post-migration PASS state.
//     Any non-empty stdout (or, defensively, exit 2 signal) is a FAIL.
//
//     Self-exclude: this script itself is added to the pathspec exclusions
//     because it literal-string-tests the legacy scope (`@earendil-works`)
//     in its own check bodies and descriptive comments — exactly the same
//     rationale the S01 guard encodes via `SELF_RELATIVE` + the whitelist
//     entry "tests/scripts/m004-s02-scope-validation.mjs". Without this
//     self-exclusion, the script would be permanently red, since its 8
//     in-source references to the legacy scope would always match the
//     very grep it runs. None of the other checks (b)–(g) use `git grep`
//     pathspec queries, so the self-exclusion is targeted here and not
//     in their invocation shapes.
// ---------------------------------------------------------------------------
{
	const r = spawnSync(
		"git",
		[
			"grep",
			"-n",
			"@earendil-works",
			"--",
			":!HISTORY.md",
			":!CHANGELOG.md",
			":!package-lock.json",
			":!tests/workflows/",
			":!tests/scripts/m004-s02-scope-validation.mjs",
		],
		{ encoding: "utf8" },
	);
	const stdout = (r.stdout ?? "").trim();
	if (stdout.length > 0) {
		fail({ key: "acceptance-grep", detail: "matched lines: " + stdout });
	}
	if (r.status !== 1 && r.status !== 0) {
		fail({
			key: "acceptance-grep",
			detail:
				"git grep exit " + r.status + " stderr=" + (r.stderr ?? "").trim(),
		});
	}
	ok(
		"acceptance-grep",
		"pathspec query returned no matches (exit " + r.status + ")",
	);
}

// ---------------------------------------------------------------------------
// (b) package.json — no legacy scope in serialized dependency tables. We
//     guard against a future upstream sync that silently re-adds the old
//     scope to one of the dep maps; the JSON.stringify round-trip is the
//     cheapest stable check for "not present at all".
// ---------------------------------------------------------------------------
{
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const serialized =
		JSON.stringify(pkg.dependencies ?? {}) +
		JSON.stringify(pkg.devDependencies ?? {}) +
		JSON.stringify(pkg.peerDependencies ?? {});
	if (/"@earendil-works\//.test(serialized)) {
		fail({
			key: "package-json-earendil",
			detail: "legacy scope found in a dep table of package.json",
		});
	}
	ok(
		"package-json-earendil",
		"no @earendil-works/* in dependencies/devDependencies/peerDependencies",
	);
}

// ---------------------------------------------------------------------------
// (c) package.json — peerDependencies expose the two host-provided packages
//     under the @gsd/* scope. Constructed access (bracket lookup, not string
//     match on the serialized JSON) so a future re-bump that changes the
//     descriptor string but keeps the package still satisfies the check.
// ---------------------------------------------------------------------------
{
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	const peers = pkg.peerDependencies ?? {};
	const scopePrefix = "@" + "gsd";
	const codingAgentKey = scopePrefix + "/" + "pi-coding-agent";
	const tuiKey = scopePrefix + "/" + "pi-tui";
	if (!peers[codingAgentKey]) {
		fail({
			key: "package-json-gsd-peer-coding-agent",
			detail: "peerDependencies missing " + codingAgentKey,
		});
	}
	if (!peers[tuiKey]) {
		fail({
			key: "package-json-gsd-peer-tui",
			detail: "peerDependencies missing " + tuiKey,
		});
	}
	ok(
		"package-json-gsd-peer-coding-agent",
		codingAgentKey + " = " + JSON.stringify(peers[codingAgentKey]),
	);
	ok(
		"package-json-gsd-peer-tui",
		tuiKey + " = " + JSON.stringify(peers[tuiKey]),
	);
}

// ---------------------------------------------------------------------------
// (d) + (e) Import surface — counted dynamically across the tracked tree.
//     `git grep -c "<pattern>"` returns one `<path>:<count>` line per match;
//     we sum the count column to validate that the fork actually USES the
//     peer packages (and not just declares them). The lower bound is a
//     post-S01 baseline, not a moving target: it lets the count grow with
//     future usage but never silently drop below the integration floor.
// ---------------------------------------------------------------------------
function countImportsGlob(pattern) {
	const r = spawnSync(
		"git",
		["grep", "-c", pattern, "--", "*.ts", "*.tsx", "*.mts", "*.mjs"],
		{ encoding: "utf8" },
	);
	if (r.status === 1 && (!r.stdout || r.stdout.trim() === "")) {
		return 0;
	}
	if (r.status !== 0) {
		fail({
			key: "import-coding-agent-count",
			detail:
				"git grep exit " + r.status + " stderr=" + (r.stderr ?? "").trim(),
		});
	}
	let total = 0;
	for (const line of r.stdout.trim().split("\n")) {
		const colonIdx = line.lastIndexOf(":");
		const n = parseInt(line.slice(colonIdx + 1), 10);
		if (!Number.isNaN(n)) total += n;
	}
	return total;
}

{
	// Build the import pattern from variables so the scope literal
	// `@gsd/pi-coding-agent` never appears as a single string in this file
	// (the file itself would otherwise be a candidate for the scope guard's
	// own match set). Equivalent to `from "@gsd/pi-coding-agent"`.
	const atSign = "@";
	const org = "gsd";
	const codingAgentName = "pi-coding-agent";
	const tuiName = "pi-tui";
	const fromOpen = "from " + '"';
	const codingAgentPattern =
		fromOpen + atSign + org + "/" + codingAgentName + '"';
	const tuiPattern = fromOpen + atSign + org + "/" + tuiName + '"';

	const codingAgentCount = countImportsGlob(codingAgentPattern);
	if (codingAgentCount < 8) {
		fail({
			key: "import-coding-agent-count",
			detail: "expected >= 8, got " + codingAgentCount,
		});
	}
	ok(
		"import-coding-agent-count",
		codingAgentCount +
			" tracked-source imports for " +
			atSign +
			org +
			"/" +
			codingAgentName,
	);

	const tuiCount = countImportsGlob(tuiPattern);
	if (tuiCount < 1) {
		fail({
			key: "import-pi-tui-count",
			detail: "expected >= 1, got " + tuiCount,
		});
	}
	ok(
		"import-pi-tui-count",
		tuiCount + " tracked-source imports for " + atSign + org + "/" + tuiName,
	);
}

// ---------------------------------------------------------------------------
// (f) Guard whitelist — the regression guard itself (T01) added HISTORY.md
//     to its `expected` array. We pin that addition lexically so a future
//     accidental revert of T01's whitelist extension reds this check before
//     the scope guard can be silently neutralized.
// ---------------------------------------------------------------------------
{
	if (!existsSync("tests/workflows/scope-migration.test.ts")) {
		fail({
			key: "guard-whitelist-history",
			detail: "scope-migration.test.ts missing",
		});
	}
	const guardSrc = readFileSync(
		"tests/workflows/scope-migration.test.ts",
		"utf8",
	);
	if (!/"HISTORY\.md"/.test(guardSrc)) {
		fail({
			key: "guard-whitelist-history",
			detail:
				'tests/workflows/scope-migration.test.ts does not list "HISTORY.md" in its whitelist',
		});
	}
	ok(
		"guard-whitelist-history",
		'"HISTORY.md" present in scope-migration.test.ts whitelist',
	);
}

// ---------------------------------------------------------------------------
// (g) Vendor description-only — vendor/pi-coding-agent/package.json is
//     regenerated from a host upstream that may still mention the legacy
//     organization in a free-form `description` string. The vendored
//     dependency DECLARATIONS must not carry an `@earendil-works/*` scope
//     even if the prose does. We assert both halves of the invariant.
// ---------------------------------------------------------------------------
{
	const vendorPath = "vendor/pi-coding-agent/package.json";
	if (!existsSync(vendorPath)) {
		fail({ key: "vendor-description-only", detail: vendorPath + " missing" });
	}
	const vendorRaw = readFileSync(vendorPath, "utf8");
	if (/@earendil-works\//.test(vendorRaw)) {
		fail({
			key: "vendor-description-only",
			detail:
				vendorPath + " contains a legacy @earendil-works/* scope reference",
		});
	}
	let vendorPkg;
	try {
		vendorPkg = JSON.parse(vendorRaw);
	} catch (e) {
		fail({
			key: "vendor-description-only",
			detail: vendorPath + " is not valid JSON: " + e.message,
		});
	}
	const desc = vendorPkg?.description ?? "";
	if (!/earendil-works/.test(desc)) {
		fail({
			key: "vendor-description-only",
			detail:
				vendorPath + " description does not mention the legacy organization",
		});
	}
	ok(
		"vendor-description-only",
		"description carries legacy mention, no @earendil-works/* scope in vendor file",
	);
}

console.log("OK: M004/S02 scope validation passed.");
