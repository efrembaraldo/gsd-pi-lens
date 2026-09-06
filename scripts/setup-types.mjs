#!/usr/bin/env node
// scripts/setup-types.mjs
//
// Two stages, both idempotent and both safe to re-run at any time:
//
//   1. Vendor (stadio 1) — copies @gsd/pi-coding-agent and @gsd/pi-tui
//      type declarations from a built gsd-pi checkout into
//      ./vendor/<pkg>/dist/. Required because @gsd/pi-* are workspace packages
//      inside the gsd-pi monorepo, NOT published as standalone npm packages,
//      so `npm install` cannot fetch them. pi-coding-agent additionally vendors
//      its compiled runtime (.js, source maps excluded) plus package.json, so
//      pi-host-contract.test.ts and host-edit-normalize-sync.test.ts can read
//      host sources and assert the host version off ./vendor/.
//
//   2. Runtime materialization (stadio 2) — copies the runtime JS (plus .d.ts
//      and source-map siblings) of @gsd/pi-tui, @gsd/native,
//      get-east-asian-width and marked into ./node_modules/. This unblocks
//      vitest at runtime: tests load clients/test-runner-delivery.ts →
//      clients/tui-fit.ts → clients/deps/pi-tui.ts → @gsd/pi-tui, and @gsd is
//      absent from the npm registry. Without this staging, `npx vitest` fails
//      with module resolution errors, not type errors.
//
//      The full closure is copied because @gsd/pi-tui/dist/utils.js statically
//      imports "@gsd/native", "@gsd/native/text", and "get-east-asian-width";
//      @gsd/pi-tui/dist/components/markdown.js imports "marked". @gsd/native is
//      CJS and its dist/ output is JS-only: its loader wraps the .node addon
//      require in try/catch and exposes `isNativeAddonLoaded()` so consumers
//      (like @gsd/pi-tui/dist/utils.js) can degrade to the JS fallback without
//      a throw. We therefore copy the dist/ tree and SKIP any native .node
//      binary (none is shipped from `tsc` output anyway).
//
// Idempotent: re-running exits 0 with per-package skip lines. Both vendor/ and
// node_modules/ are gitignored. A subsequent `npm install` may prune extraneous
// packages from node_modules/, so this script MUST be re-run after every
// `npm install` (S03/S04 and CI run it post-clone).
//
// Resolution priority for the gsd-pi checkout (shared by both stages):
//   1. GSD_PI_CHECKOUT env var (explicit override; CI uses /tmp/gsd-pi)
//   2. /home/opengsd/repos/open-gsd_gsd-pi (canonical local dev path)
//   3. /tmp/gsd-pi (CI default)

import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	realpathSync,
	copyFileSync,
	cpSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

// ─── Stadio 1: vendor .d.ts (+ runtime .js + package.json for pi-coding-agent) ─
// Each entry maps a package name to its expected destination (a subdirectory of
// ./vendor/). Skip is per-package and multi-sentinel: see vendorSentinels(). A
// copyJs package vendors .d.ts AND .js (minus .js.map) plus its package.json, so
// a vendor populated by an earlier S01 run (index.d.ts only) still re-copies the
// runtime on a partial sentinel (idempotent). pi-tui has no .js consumer in the
// test suite and stays .d.ts-only.
const VENDOR_PACKAGES = [
	{
		name: "pi-coding-agent",
		dest: join(ROOT, "vendor", "pi-coding-agent", "dist"),
		copyJs: true,
	},
	{ name: "pi-tui", dest: join(ROOT, "vendor", "pi-tui", "dist") },
];

// ─── Stadio 2: runtime materialization in node_modules/ ─────────────────────
// Each entry declares:
//   - scope:        "@gsd" → node_modules/@gsd/<name>/; "" → node_modules/<name>/
//   - sentinel:     relative path(s) inside the dest; ALL must exist to skip
//   - sourcePath:   absolute path under the gsd-pi checkout (function, receives
//                   the resolved checkout root)
//   - copyFiles:    top-level files to copy verbatim (fail-loud if missing)
//   - copyDirs:     top-level directories to copy recursively with symlinks
//                   dereferenced (pnpm's node_modules entries are symlinks —
//                   `cpSync` with dereference:true resolves them at copy time)
//
// @gsd/native intentionally omits any .node addon: its loader has a try/catch
// around `require(...)` for the Rust binary and returns a throw-on-call Proxy
// on failure, while `isNativeAddonLoaded()` reports false. @gsd/pi-tui's
// `try { return isNativeAddonLoaded(); } catch { return false; }` wrapper then
// degrades to its JS fallback (verified against dist/utils.js sourcesContent).
const RUNTIME_PACKAGES = [
	{
		scope: "@gsd",
		name: "pi-tui",
		sentinel: ["dist/index.js"],
		sourcePath: (checkout) => join(checkout, "packages", "pi-tui"),
		copyFiles: ["package.json"],
		copyDirs: ["dist"],
	},
	{
		scope: "@gsd",
		name: "native",
		sentinel: ["dist/index.js"],
		sourcePath: (checkout) => join(checkout, "packages", "native"),
		copyFiles: ["package.json"],
		copyDirs: ["dist"],
	},
	{
		scope: "",
		name: "get-east-asian-width",
		sentinel: ["package.json"],
		sourcePath: (checkout) => join(checkout, "node_modules", "get-east-asian-width"),
		copyFiles: [
			"package.json",
			"index.d.ts",
			"index.js",
			"lookup.js",
			"lookup-data.js",
			"utilities.js",
		],
		copyDirs: [],
	},
	{
		scope: "",
		name: "marked",
		sentinel: ["package.json"],
		sourcePath: (checkout) => join(checkout, "node_modules", "marked"),
		copyFiles: ["package.json", "marked.min.js"],
		copyDirs: ["bin", "lib", "man"],
	},
];

const CHECKOUT_CANDIDATES = [
	process.env.GSD_PI_CHECKOUT,
	"/home/opengsd/repos/open-gsd_gsd-pi",
	"/tmp/gsd-pi",
];

// ─── Stadio 1 helpers ──────────────────────────────────────────────────────
function copyVendorDir(srcDir, dstDir, copyJs) {
	for (const entry of readdirSync(srcDir)) {
		const srcPath = join(srcDir, entry);
		const dstPath = join(dstDir, entry);
		const stat = statSync(srcPath);
		if (stat.isDirectory()) {
			mkdirSync(dstPath, { recursive: true });
			copyVendorDir(srcPath, dstPath, copyJs);
		} else if (entry.endsWith(".d.ts")) {
			// .d.ts always; .d.ts.map never (ends with ".map", not ".d.ts").
			copyFileSync(srcPath, dstPath);
		} else if (copyJs && entry.endsWith(".js") && !entry.endsWith(".js.map")) {
			// Widens the S01 .d.ts-only copy to the compiled runtime. Excluding
			// *.js.map (~1.8 MB) keeps the vendored dist lean; no readHostSource
			// consumer reads a map. Only pi-coding-agent vendors .js.
			copyFileSync(srcPath, dstPath);
		}
	}
}

// Returns the skip sentinels for a vendor package, relative to the package root
// (the parent of the dist destination). A copyJs package needs all three markers
// to be skipped, so a vendor populated type-only by an earlier S01 run (index.d.ts
// present, index.js / package.json absent) is re-copied in full on the next run.
function vendorSentinels(pkg) {
	const packageRoot = dirname(pkg.dest);
	if (pkg.copyJs) {
		return [
			join(pkg.dest, "index.d.ts"),
			join(pkg.dest, "index.js"),
			join(packageRoot, "package.json"),
		];
	}
	return [join(pkg.dest, "index.d.ts")];
}

function planVendor() {
	const pending = [];
	for (const pkg of VENDOR_PACKAGES) {
		const sentinels = vendorSentinels(pkg);
		if (sentinels.every((s) => existsSync(s))) {
			const rel = sentinels.map((s) => s.replace(join(ROOT, "") + "/", ""));
			console.log(
				`[setup-types] ${rel.join(", ")} already present, skipping`,
			);
			continue;
		}
		pending.push(pkg);
	}
	return pending;
}

function failMissingVendorFile(pkg, sourcePath, kind) {
	console.error(
		`[setup-types] FAIL: vendor ${kind} source missing for ${pkg.name}`,
	);
	console.error(`  Expected: ${sourcePath}`);
	process.exit(1);
}

// ─── Stadio 2 helpers ──────────────────────────────────────────────────────
// Returns true iff every sentinella file for the package is present under its
// node_modules destination.
function allSentinelsPresent(pkg) {
	const scopeSegment = pkg.scope ? join(pkg.scope, pkg.name) : pkg.name;
	const destBase = join(ROOT, "node_modules", scopeSegment);
	return pkg.sentinel.every((rel) => existsSync(join(destBase, rel)));
}

function planRuntime() {
	const pending = [];
	for (const pkg of RUNTIME_PACKAGES) {
		if (allSentinelsPresent(pkg)) {
			const scopeSegment = pkg.scope ? join(pkg.scope, pkg.name) : pkg.name;
			const sentinelsRel = pkg.sentinel.join(", ");
			console.log(
				`[setup-types] node_modules/${scopeSegment}/${sentinelsRel} already present, skipping`,
			);
			continue;
		}
		pending.push(pkg);
	}
	return pending;
}

function failNoSource(pkg, sourcePath) {
	const scopeSegment = pkg.scope ? join(pkg.scope, pkg.name) : pkg.name;
	console.error(
		`[setup-types] FAIL: runtime materialization source missing for ${scopeSegment}`,
	);
	console.error(`  Expected: ${sourcePath}`);
	process.exit(1);
}

function failMissingEntry(pkg, sourceReal, kind, name) {
	const scopeSegment = pkg.scope ? join(pkg.scope, pkg.name) : pkg.name;
	console.error(
		`[setup-types] FAIL: expected ${kind} '${name}' missing in source for ${scopeSegment}`,
	);
	console.error(`  Source: ${sourceReal}`);
	process.exit(1);
}

function materializeRuntimePackage(pkg, checkout) {
	const sourceRaw = pkg.sourcePath(checkout);
	if (!existsSync(sourceRaw)) {
		failNoSource(pkg, sourceRaw);
	}
	// pnpm node_modules entries are symlinks into .pnpm/<name>@<ver>/...
	// Resolve the link so cpSync copies real files, not symlinks.
	const sourceReal = realpathSync(sourceRaw);

	const scopeSegment = pkg.scope ? join(pkg.scope, pkg.name) : pkg.name;
	const destBase = join(ROOT, "node_modules", scopeSegment);

	console.log(
		`[setup-types] materializing ${scopeSegment}/ (from ${sourceReal})`,
	);
	mkdirSync(destBase, { recursive: true });

	for (const f of pkg.copyFiles) {
		const src = join(sourceReal, f);
		if (!existsSync(src)) {
			failMissingEntry(pkg, sourceReal, "file", f);
		}
		copyFileSync(src, join(destBase, f));
	}
	for (const d of pkg.copyDirs) {
		const src = join(sourceReal, d);
		if (!existsSync(src)) {
			failMissingEntry(pkg, sourceReal, "directory", d);
		}
		const dst = join(destBase, d);
		// `recursive: true` walks the directory tree; `dereference: true`
		// resolves any symlinks encountered during the walk. The source
		// directory itself is already realpath'd above, so this primarily
		// guards nested symlinks (none expected, but defensive).
		cpSync(src, dst, { recursive: true, dereference: true });
	}
}

// ─── Checkout resolution ────────────────────────────────────────────────────
// Returns the first candidate for which BOTH stages have all required sources,
// or null if no candidate is complete. Resolved only when at least one stage has
// pending work; an empty pending list for both stages short-circuits to "all
// done" before this is called.
function resolveCheckout(pendingVendor, pendingRuntime) {
	for (const candidate of CHECKOUT_CANDIDATES) {
		if (!candidate) continue;

		let vendorOk = true;
		for (const pkg of pendingVendor) {
			if (
				!existsSync(
					join(candidate, "packages", pkg.name, "dist", "index.d.ts"),
				)
			) {
				vendorOk = false;
				break;
			}
			// A copyJs package also needs the compiled runtime at source, not just
			// the type declarations, or the .js re-pin would be unverifiable.
			if (
				pkg.copyJs &&
				!existsSync(
					join(candidate, "packages", pkg.name, "dist", "index.js"),
				)
			) {
				vendorOk = false;
				break;
			}
		}
		if (!vendorOk) continue;

		let runtimeOk = true;
		for (const pkg of pendingRuntime) {
			// existsSync follows symlinks, which is exactly what we need for
			// the pnpm-managed get-east-asian-width / marked entries.
			if (!existsSync(pkg.sourcePath(candidate))) {
				runtimeOk = false;
				break;
			}
		}
		if (!runtimeOk) continue;

		return candidate;
	}
	return null;
}

function failNoCheckout(pendingVendor, pendingRuntime) {
	console.error(
		"[setup-types] FAIL: no built gsd-pi checkout found for one or more pending packages",
	);
	console.error("");

	if (pendingVendor.length > 0) {
		console.error(
			`  Pending vendor packages (no .d.ts dest): ${pendingVendor.map((p) => p.name).join(", ")}`,
		);
		console.error("");
		console.error("  Tried (vendor):");
		for (const c of CHECKOUT_CANDIDATES.filter(Boolean)) {
			for (const pkg of pendingVendor) {
				console.error(`    - ${c}/packages/${pkg.name}/dist/index.d.ts`);
				if (pkg.copyJs) {
					console.error(`    - ${c}/packages/${pkg.name}/dist/index.js`);
				}
			}
		}
		console.error("");
	}

	if (pendingRuntime.length > 0) {
		console.error(
			`  Pending runtime packages (no node_modules dest): ${pendingRuntime.map((p) => `${p.scope ? p.scope + "/" : ""}${p.name}`).join(", ")}`,
		);
		console.error("");
		console.error("  Tried (runtime):");
		for (const c of CHECKOUT_CANDIDATES.filter(Boolean)) {
			for (const pkg of pendingRuntime) {
				console.error(`    - ${pkg.sourcePath(c)}`);
			}
		}
		console.error("");
	}

	console.error("  Fix:");
	console.error(
		"    - Set GSD_PI_CHECKOUT=<path> to a gsd-pi checkout with the required build outputs",
	);
	console.error(
		"    - OR clone+build it: git clone https://github.com/open-gsd/gsd-pi.git /tmp/gsd-pi && cd /tmp/gsd-pi && pnpm install && pnpm --filter @gsd/pi-tui build && pnpm --filter @gsd/native build && pnpm --filter @gsd/pi-coding-agent... build",
	);
	process.exit(1);
}

// ─── Main ───────────────────────────────────────────────────────────────────
const pendingVendor = planVendor();
const pendingRuntime = planRuntime();

if (pendingVendor.length === 0 && pendingRuntime.length === 0) {
	console.log(
		"[setup-types] all vendor and runtime destinations already present, nothing to do",
	);
	process.exit(0);
}

const resolvedCheckout = resolveCheckout(pendingVendor, pendingRuntime);
if (!resolvedCheckout) {
	failNoCheckout(pendingVendor, pendingRuntime);
}

// Stadio 1 — vendor (.d.ts, plus .js + package.json for copyJs packages).
for (const pkg of pendingVendor) {
	const sourceDist = join(resolvedCheckout, "packages", pkg.name, "dist");
	const copyJs = !!pkg.copyJs;
	console.log(
		`[setup-types] copying ${copyJs ? ".d.ts and .js (+.js.map excluded)" : ".d.ts"} from ${sourceDist} -> ${pkg.dest}`,
	);
	mkdirSync(pkg.dest, { recursive: true });
	copyVendorDir(sourceDist, pkg.dest, copyJs);
	if (copyJs) {
		const srcPkgJson = join(dirname(sourceDist), "package.json");
		if (!existsSync(srcPkgJson)) {
			failMissingVendorFile(pkg, srcPkgJson, "package.json");
		}
		copyFileSync(srcPkgJson, join(dirname(pkg.dest), "package.json"));
	}
}

// Stadio 2 — runtime materialization in node_modules/.
for (const pkg of pendingRuntime) {
	materializeRuntimePackage(pkg, resolvedCheckout);
}

console.log(`[setup-types] done (from ${resolvedCheckout})`);
