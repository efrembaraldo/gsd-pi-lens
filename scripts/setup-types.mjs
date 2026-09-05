#!/usr/bin/env node
// scripts/setup-types.mjs
//
// Copies @gsd/pi-coding-agent and @gsd/pi-tui .d.ts files from a built gsd-pi
// checkout into ./vendor/<pkg>/dist/. Required because @gsd/pi-* are workspace
// packages inside the gsd-pi monorepo, NOT published as standalone npm packages,
// so `npm install` cannot fetch them.
//
// Idempotent: exits 0 if both vendor destinations already present.
// Per-package skip: each destination is evaluated independently, so re-running
// after populating only one of them completes the missing one without re-copying
// the existing one (and skips it with its own log line).
//
// Resolution priority for the gsd-pi checkout:
//   1. GSD_PI_CHECKOUT env var (explicit override; CI uses /tmp/gsd-pi)
//   2. /home/opengsd/repos/open-gsd_gsd-pi (canonical local dev path)
//   3. /tmp/gsd-pi (CI default)
//
// Vendor/ is gitignored: this script is meant to run post-clone (CI does so in
// the S04 image build); the vendored .d.ts files are NOT shipped in the tarball.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// Packages to vendor. Each entry maps a package name to its expected destination
// (a subdirectory of ./vendor/). Both are required for the fork's compile/test
// surface; the script fails loudly if any one source is missing.
const PACKAGES = [
	{ name: "pi-coding-agent", dest: join(ROOT, "vendor", "pi-coding-agent", "dist") },
	{ name: "pi-tui", dest: join(ROOT, "vendor", "pi-tui", "dist") },
];

const CHECKOUT_CANDIDATES = [
	process.env.GSD_PI_CHECKOUT,
	"/home/opengsd/repos/open-gsd_gsd-pi",
	"/tmp/gsd-pi",
];

/**
 * For each package, decide whether the vendor destination is already populated
 * (per-package skip) OR needs copying. Returns a list of pending packages and
 * the resolved source path (or null if none of the candidates is usable).
 */
function planPackages() {
	const pending = [];
	let resolvedCheckout = null;

	for (const pkg of PACKAGES) {
		const destIndex = join(pkg.dest, "index.d.ts");
		if (existsSync(destIndex)) {
			console.log(
				`[setup-types] vendor/${pkg.name}/dist/index.d.ts already present, skipping`,
			);
			continue;
		}
		pending.push(pkg);
	}

	if (pending.length === 0) {
		return { pending: [], resolvedCheckout: null };
	}

	for (const candidate of CHECKOUT_CANDIDATES) {
		if (!candidate) continue;
		let allFound = true;
		for (const pkg of pending) {
			const sourceDist = join(
				candidate,
				"packages",
				pkg.name,
				"dist",
				"index.d.ts",
			);
			if (!existsSync(sourceDist)) {
				allFound = false;
				break;
			}
		}
		if (allFound) {
			resolvedCheckout = candidate;
			break;
		}
	}

	return { pending, resolvedCheckout };
}

function copyDtsOnly(srcDir, dstDir) {
	for (const entry of readdirSync(srcDir)) {
		const srcPath = join(srcDir, entry);
		const dstPath = join(dstDir, entry);
		const stat = statSync(srcPath);
		if (stat.isDirectory()) {
			mkdirSync(dstPath, { recursive: true });
			copyDtsOnly(srcPath, dstPath);
		} else if (entry.endsWith(".d.ts")) {
			copyFileSync(srcPath, dstPath);
		}
	}
}

function failNoCheckout(pending) {
	console.error(
		"[setup-types] FAIL: no built gsd-pi checkout found for one or more pending packages",
	);
	console.error("");
	console.error(`  Pending packages (no vendor dest): ${pending.map((p) => p.name).join(", ")}`);
	console.error("");
	console.error("  Tried:");
	for (const c of CHECKOUT_CANDIDATES.filter(Boolean)) {
		for (const pkg of pending) {
			console.error(`    - ${c}/packages/${pkg.name}/dist/index.d.ts`);
		}
	}
	console.error("");
	console.error("  Fix:");
	console.error(
		"  - Set GSD_PI_CHECKOUT=<path> to a gsd-pi checkout with packages/<name>/dist/ already built",
	);
	console.error(
		"  - OR build it: cd <gsd-pi-checkout> && pnpm install && pnpm --filter @gsd/pi-tui build && pnpm --filter @gsd/pi-coding-agent... build",
	);
	console.error(
		"  - OR clone+build it: git clone https://github.com/open-gsd/gsd-pi.git /tmp/gsd-pi && cd /tmp/gsd-pi && pnpm install && pnpm --filter @gsd/pi-coding-agent... build",
	);
	process.exit(1);
}

const { pending, resolvedCheckout } = planPackages();

if (pending.length === 0) {
	console.log("[setup-types] all vendor destinations already present, nothing to do");
	process.exit(0);
}

if (!resolvedCheckout) {
	failNoCheckout(pending);
}

for (const pkg of pending) {
	const sourceDist = join(resolvedCheckout, "packages", pkg.name, "dist");
	console.log(`[setup-types] copying .d.ts from ${sourceDist} -> ${pkg.dest}`);
	mkdirSync(pkg.dest, { recursive: true });
	copyDtsOnly(sourceDist, pkg.dest);
}

console.log(`[setup-types] done (from ${resolvedCheckout})`);
