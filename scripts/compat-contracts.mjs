#!/usr/bin/env node
/**
 * Layer A: pinned-contract verification (#476).
 *
 * pi-lens's subagent-compatibility features (#473/#474/#475) were built on
 * reverse-engineered facts about three third-party pi extensions and the pi
 * SDK itself — nobody has promised us these stay true across their releases.
 * This script mechanically re-verifies each pinned contract with RESILIENT
 * pattern checks (scripts/lib/compat-contracts.mjs) against the real code —
 * never a line number, a semantic shape — so a wording/formatting change
 * that preserves the behavior we depend on still passes.
 *
 * Source split in the @gsd world:
 *   - The three third-party pi extensions (pi-subagents, avtc-pi-subagent,
 *     @tintinweb/pi-subagents) are npm-installable and are installed into a
 *     scratch directory.
 *   - The SDK (packages @gsd/pi-coding-agent + @gsd/agent-core) is a gsd-pi
 *     monorepo workspace and is ABSENT from the npm registry, so it is never
 *     npm-installed here; its four dist sources are read directly from a
 *     built gsd-pi checkout, resolved through the same candidate list as
 *     scripts/setup-types.mjs.
 *
 * Requires NO LLM API key and spawns no `pi` process — CI has no model
 * credentials, so this is the layer that runs even when Layer B
 * (compat-smoke-behavioral.mjs) can't.
 *
 * Exit code: 0 = all checks pass; 1 = any contract check FAILs (real drift);
 * 2 = infrastructure failure (npm install of the third-party packages failed,
 * or no built gsd-pi checkout / missing SDK dist file). The workflow step
 * wraps this in `continue-on-error: true` so a failure ALERTS rather than
 * reds the nightly; see docs/subagent-compat.md.
 *
 * Usage: node scripts/compat-contracts.mjs [--keep] [--dir <path>]
 *   --keep       don't delete the scratch install directory on exit
 *   --dir <path> use this directory instead of a fresh temp dir (skips
 *                install if package.json already exists there — useful for
 *                iterating locally without re-installing every run)
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAllContractChecks } from "./lib/compat-contracts.mjs";

// Only the third-party extensions are npm-installable. The @gsd SDK packages
// are gsd-pi monorepo workspaces read from a local checkout (never installed).
//
// nicobailon is PINNED (pi-subagents@0.34.0): pi-subagents@0.65.x dropped the
// `PI_SUBAGENT_RUN_ID` / `PI_SUBAGENT_CHILD_AGENT` env vars that contract 1's
// best-effort identity half depends on (pi-lens degrades to "unknown" when they
// are absent, per subagent-mode.ts). The frozen check-1 matcher is therefore
// verified against the 0.34.0 baseline that still carries the full contract;
// re-deriving contract 1 for the current pi-subagents shape is a standalone
// follow-up (see docs/subagent-compat.md) and is NOT part of the @gsd rescope.
const PACKAGES = {
	nicobailon: "pi-subagents@0.34.0",
	avtc: "avtc-pi-subagent",
	tintinweb: "@tintinweb/pi-subagents",
};

// gsd-pi checkout resolution — same candidate list as scripts/setup-types.mjs
// (which we deliberately do NOT import: it executes its logic at top level).
// The SDK dist sources are read from the resolved checkout.
const CHECKOUT_CANDIDATES = [
	process.env.GSD_PI_CHECKOUT,
	"/home/opengsd/repos/open-gsd_gsd-pi",
	"/tmp/gsd-pi",
];

const SDK_SOURCES = {
	sdkLoaderSource: "packages/pi-coding-agent/dist/core/extensions/loader.js",
	sdkRunnerSource: "packages/pi-coding-agent/dist/core/extensions/runner.js",
	sdkAgentSessionExtensionsSource:
		"packages/gsd-agent-core/dist/session/agent-session-extensions.js",
	sdkAgentSessionEventsSource:
		"packages/gsd-agent-core/dist/session/agent-session-events.js",
};

// Package.json relative paths (under the checkout) whose `version` field
// becomes each SDK package's reported version for GITHUB_OUTPUT.
const SDK_PACKAGE_JSON = {
	"@gsd/pi-coding-agent": "packages/pi-coding-agent",
	"@gsd/agent-core": "packages/gsd-agent-core",
};

function parseArgs(argv) {
	const opts = { keep: false, dir: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--keep") opts.keep = true;
		else if (argv[i] === "--dir") opts.dir = argv[++i];
	}
	return opts;
}

function installPackages(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const pkgJsonPath = path.join(dir, "package.json");
	if (!fs.existsSync(pkgJsonPath)) {
		fs.writeFileSync(
			pkgJsonPath,
			JSON.stringify(
				{ name: "pi-lens-compat-contracts-scratch", private: true },
				null,
				2,
			),
		);
	}
	const specs = Object.values(PACKAGES);
	console.log(`installing ${specs.join(", ")} into ${dir} ...`);
	// Windows `npm` is a `.cmd` shim that only runs under shell mode (same
	// reasoning as safeSpawnAsync — see AGENTS.md "Runner process model").
	const isWindows = process.platform === "win32";
	execFileSync(
		"npm",
		["install", "--no-audit", "--no-fund", "--no-save", ...specs],
		{
			cwd: dir,
			stdio: "inherit",
			shell: isWindows,
		},
	);
}

function installedVersion(dir, pkgName) {
	try {
		const pkgJsonPath = path.join(dir, "node_modules", pkgName, "package.json");
		return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
	} catch {
		return "(unknown)";
	}
}

function readSource(dir, ...segments) {
	return fs.readFileSync(path.join(dir, "node_modules", ...segments), "utf8");
}

// Returns the first checkout candidate for which EVERY SDK dist source exists,
// or null if no candidate is complete (fail-loud precondition of the run).
function resolveCheckout() {
	for (const candidate of CHECKOUT_CANDIDATES) {
		if (!candidate) continue;
		const ok = Object.values(SDK_SOURCES).every((rel) =>
			fs.existsSync(path.join(candidate, rel)),
		);
		if (ok) return candidate;
	}
	return null;
}

function checkoutPackageVersion(checkout, pkgRelDir) {
	try {
		const pkgJsonPath = path.join(checkout, pkgRelDir, "package.json");
		return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
	} catch {
		return "(unknown)";
	}
}

function readCheckoutSource(checkout, rel) {
	return fs.readFileSync(path.join(checkout, rel), "utf8");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const dir =
		opts.dir ??
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-compat-contracts-"));

	// Resolve the SDK checkout BEFORE any install so a missing checkout fails
	// fast and loudly (the SDK can never be npm-installed).
	const checkout = resolveCheckout();
	if (!checkout) {
		console.error(
			"\nINFRA FAILURE — no built gsd-pi checkout found; SDK sources are read from a local checkout, never npm-installed (@gsd packages are absent from the npm registry)",
		);
		console.error("  Tried:");
		for (const c of CHECKOUT_CANDIDATES.filter(Boolean)) {
			for (const rel of Object.values(SDK_SOURCES)) {
				console.error(`    - ${path.join(c, rel)}`);
			}
		}
		console.error(
			"  Fix: set GSD_PI_CHECKOUT=<path> to a built gsd-pi checkout, or clone+build it (see scripts/setup-types.mjs failure output)",
		);
		if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
		process.exit(2);
	}

	let infraFailure = null;
	try {
		installPackages(dir);
	} catch (err) {
		// Our own install failing (network/registry down) is an infra error, not
		// a contract drift — the workflow should tell these apart in its summary.
		infraFailure = err instanceof Error ? err.message : String(err);
	}

	const checkoutVersions = (pairs) =>
		Object.fromEntries(
			Object.entries(pairs).map(([name, rel]) => [
				name,
				checkoutPackageVersion(checkout, rel),
			]),
		);
	const versions = {
		...checkoutVersions(SDK_PACKAGE_JSON),
		"pi-subagents": installedVersion(dir, "pi-subagents"),
		"avtc-pi-subagent": installedVersion(dir, "avtc-pi-subagent"),
		"@tintinweb/pi-subagents": installedVersion(dir, "@tintinweb/pi-subagents"),
	};
	console.log(
		"\nversions (third-party installed from npm; SDK read from gsd-pi checkout):",
	);
	for (const [name, version] of Object.entries(versions)) {
		console.log(`  ${name}@${version}`);
	}
	// Surface the ACTUALLY-verified versions to the workflow (GITHUB_OUTPUT)
	// so the drift-alert issue states ground truth — the doc's "verified
	// against" versions go stale as nightlies silently pass on newer releases.
	if (process.env.GITHUB_OUTPUT) {
		const line = Object.entries(versions)
			.map(([name, version]) => `${name}@${version}`)
			.join(" ");
		try {
			fs.appendFileSync(process.env.GITHUB_OUTPUT, `versions=${line}\n`);
		} catch {
			// output plumbing is best-effort; stdout above already has the versions
		}
	}

	if (infraFailure) {
		console.error(
			`\nINFRA FAILURE — could not install third-party packages: ${infraFailure}`,
		);
		if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
		process.exit(2);
	}

	let inputs;
	try {
		inputs = {
			nicobailonPiArgsSource: readSource(
				dir,
				"pi-subagents",
				"src/runs/shared/pi-args.ts",
			),
			avtcProcessRunnerSource: readSource(
				dir,
				"avtc-pi-subagent",
				"src/process-runner.ts",
			),
			sdkLoaderSource: readCheckoutSource(
				checkout,
				SDK_SOURCES.sdkLoaderSource,
			),
			sdkRunnerSource: readCheckoutSource(
				checkout,
				SDK_SOURCES.sdkRunnerSource,
			),
			sdkAgentSessionExtensionsSource: readCheckoutSource(
				checkout,
				SDK_SOURCES.sdkAgentSessionExtensionsSource,
			),
			sdkAgentSessionEventsSource: readCheckoutSource(
				checkout,
				SDK_SOURCES.sdkAgentSessionEventsSource,
			),
			tintinwebAgentRunnerSource: readSource(
				dir,
				"@tintinweb/pi-subagents",
				"src/agent-runner.ts",
			),
		};
	} catch (err) {
		// A source file moved/renamed entirely — itself a drift signal worth
		// surfacing distinctly from an individual contract regex not matching.
		console.error(
			`\nINFRA FAILURE — expected source file not found (SDK file or package layout changed?): ${err instanceof Error ? err.message : err}`,
		);
		if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
		process.exit(2);
	}

	const { results, allPass } = runAllContractChecks(inputs);

	console.log("\ncontract checks:");
	for (const r of results) {
		console.log(
			`  [${r.pass ? "PASS" : "FAIL"}] ${r.id} (${r.package}) — ${r.description}`,
		);
		console.log(`         ${r.detail}`);
	}

	if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });

	console.log(
		`\n${allPass ? "ALL CONTRACT CHECKS PASSED" : "ONE OR MORE CONTRACT CHECKS FAILED"}`,
	);
	process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
	console.error("compat-contracts.mjs crashed:", err);
	process.exit(2);
});