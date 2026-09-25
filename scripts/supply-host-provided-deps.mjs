#!/usr/bin/env node
/**
 * Print what a CI smoke check needs in order to load the compiled entry outside
 * pi. #1926.
 *
 * pi supplies `typebox` and `@gsd/pi-tui` from its own runtime, so
 * pi-lens declares them as optional peers and no install vendors them. A CI step
 * that runs a bare `node dist/index.js` is not pi, so nothing resolves those
 * specifiers and the entry throws before it can prove anything. Such a step must
 * install them first, exactly as pi provides them.
 *
 * Three modes, all reading the same list so no workflow hardcodes a package name:
 *
 *   --install-args   the runtime packages plus their required ranges, ready to
 *                    pass to `npm install`. Only the VALUE-imported ones: the
 *                    type-only host SDK must never be installed (MAX_PATH).
 *                    Printed as-is even for @gsd/pi-tui, which a bare `npm
 *                    install` of this output CANNOT actually satisfy (see
 *                    --install below) -- kept unchanged because
 *                    tests/scripts/supply-host-provided-deps.test.ts and
 *                    scripts/release-qa.mjs both pin/consume this exact
 *                    newline-delimited "name@range per package" contract.
 *   --allow-pattern  an ERE alternation of the TYPE-ONLY host packages, for the
 *                    smoke step's missing-module grep. Only the type-only ones,
 *                    deliberately: every caller supplies the runtime ones first,
 *                    so a runtime host package still missing at load IS a
 *                    failure and the grep must catch it. Allowing the whole
 *                    host-provided set would make that step unable to fail —
 *                    bare node would always die at the first host import and the
 *                    allowlist would always match. The step's purpose is to fail
 *                    on an unresolved dependency; it caught the minimatch class
 *                    once.
 *   --install <dir>  actually supplies every HOST_PROVIDED_RUNTIME_PACKAGES
 *                    entry into <dir>/node_modules, choosing the right
 *                    mechanism per package (see installHostProvidedPackages
 *                    below). This is the mode a CI/QA step should call --
 *                    --install-args exists for callers with their own reason
 *                    to drive `npm install` themselves.
 *
 * USAGE (install everything, the way pi does)
 *   node scripts/supply-host-provided-deps.mjs --install "$INSTALL_DIR"
 *
 * USAGE (raw args, for a caller with its own npm install step)
 *   HOST_PKGS=()
 *   while IFS= read -r pkg; do
 *     [ -n "$pkg" ] && HOST_PKGS+=("$pkg")
 *   done < <(node scripts/supply-host-provided-deps.mjs --install-args)
 *   npm install --no-save "${HOST_PKGS[@]}"
 *   PATTERN=$(node scripts/supply-host-provided-deps.mjs --allow-pattern)
 *
 * `--install-args` prints one `name@range` per LINE (never space-joined): a
 * peer range can itself contain a space (an OR-form semver range like
 * "^0.84.1 || ^0.85.0"), so a caller must split on newlines only. Use the
 * portable `while IFS= read -r` loop above, never `read -ra ... <<< "$(...)"`
 * or a bare unquoted `$(...)` expansion (both word-split on the range's
 * internal space too and hand npm a broken extra argv token, #2586 review
 * F1) — and never bash 4+'s `mapfile -t` either: it does not exist on
 * macOS's shipped bash 3.2 (Apple has not updated bash past the GPLv2
 * license cutoff), so `mapfile` on a macOS runner fails with
 * `mapfile: command not found` (#2586 review round 3).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	HOST_PROVIDED_RUNTIME_PACKAGES,
	HOST_PROVIDED_TYPE_ONLY_PACKAGES,
} from "./lib/host-provided-deps.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @gsd/pi-tui is a workspace-only package inside the gsd-pi monorepo --
 * confirmed via `npm view @gsd/pi-tui` returning a real E404 against the
 * public registry, not a naming typo -- so `npm install @gsd/pi-tui@<range>`
 * can never succeed on its own. pi supplies it from its OWN vendored copy at
 * runtime; the published `@opengsd/gsd-pi` package (pi itself) ships that
 * same copy nested under its own node_modules/@gsd/pi-tui (verified:
 * @opengsd/gsd-pi@1.20.1 vendors node_modules/@gsd/pi-tui@1.20.1, which
 * satisfies this repo's declared "^1.19.0" peer range). `installHostProvided
 * Packages` below mirrors that: install @opengsd/gsd-pi into a scratch dir,
 * then copy its nested @gsd/pi-tui into the target install, so a bare `node`
 * load resolves the specifier the same way pi's own runtime does.
 */
const EXTRACTED_VIA_OPENGSD_PI = "@gsd/pi-tui";
const OPENGSD_GSD_PI = "@opengsd/gsd-pi";

function readPeerRanges() {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	);
	return pkg.peerDependencies ?? {};
}

function requirePeerRanges(names, ranges) {
	const missing = names.filter((name) => !Object.hasOwn(ranges, name));
	if (missing.length > 0) {
		// A required package with no peer range means the declaration drifted
		// from its source list; installing an unpinned copy would hide that.
		console.error(
			`[supply] no peerDependencies range for: ${missing.join(", ")} — ` +
				"declare each as an optional peer (#1926).",
		);
		process.exit(1);
	}
}

function npmInstall(args, cwd) {
	// Windows resolves `npm` through npm.cmd, which execFileSync cannot spawn
	// directly without a shell (ENOENT) -- shell:true lets cmd.exe do that
	// resolution, same requirement as every other cross-platform npm spawn in
	// this repo's scripts.
	execFileSync("npm", args, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
}

/** Installs every HOST_PROVIDED_RUNTIME_PACKAGES entry into installDir/node_modules. */
function installHostProvidedPackages(installDir) {
	const ranges = readPeerRanges();
	requirePeerRanges(HOST_PROVIDED_RUNTIME_PACKAGES, ranges);

	const direct = HOST_PROVIDED_RUNTIME_PACKAGES.filter(
		(name) => name !== EXTRACTED_VIA_OPENGSD_PI,
	);
	if (direct.length > 0) {
		npmInstall(
			[
				"install",
				"--no-save",
				"--no-audit",
				"--no-fund",
				"--prefix",
				installDir,
				...direct.map((name) => `${name}@${ranges[name]}`),
			],
			root,
		);
	}

	if (!HOST_PROVIDED_RUNTIME_PACKAGES.includes(EXTRACTED_VIA_OPENGSD_PI)) {
		return;
	}
	requirePeerRanges([OPENGSD_GSD_PI], ranges);
	const gsdPiRange = ranges[OPENGSD_GSD_PI];

	const scratch = fs.mkdtempSync(
		path.join(fs.realpathSync(os.tmpdir()), "opengsd-gsd-pi-"),
	);
	try {
		npmInstall(
			[
				"install",
				"--no-save",
				"--no-audit",
				"--no-fund",
				`${OPENGSD_GSD_PI}@${gsdPiRange}`,
			],
			scratch,
		);
		const nested = path.join(
			scratch,
			"node_modules",
			"@opengsd",
			"gsd-pi",
			"node_modules",
			"@gsd",
			"pi-tui",
		);
		if (!fs.existsSync(nested)) {
			console.error(
				`[supply] ${OPENGSD_GSD_PI}@${gsdPiRange} did not vendor ` +
					`${EXTRACTED_VIA_OPENGSD_PI} at ${nested}`,
			);
			process.exit(1);
		}
		const dest = path.join(installDir, "node_modules", "@gsd", "pi-tui");
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.rmSync(dest, { recursive: true, force: true });
		// dereference:true is load-bearing, not a defensive default: npm
		// resolves @opengsd/gsd-pi's OWN internal dependency on @gsd/pi-tui as
		// a `file:` reference into its own bundled packages/pi-tui source (the
		// monorepo ships both), so node_modules/@gsd/pi-tui inside the scratch
		// install is itself a SYMLINK, not a real directory. cpSync's default
		// (dereference:false) copies that symlink as a symlink pointing back
		// into `scratch` -- which the `finally` block below deletes moments
		// later, leaving a dangling symlink at dest. The very next CI step
		// (Verify extension entry loads) then throws ERR_MODULE_NOT_FOUND, not
		// because @gsd/pi-tui failed to copy, but because what got copied was
		// a pointer to a path that no longer exists by the time anything reads
		// it. dereference:true copies the symlink's TARGET content instead, so
		// dest is self-contained and survives the scratch cleanup.
		fs.cpSync(nested, dest, { recursive: true, dereference: true });
		// Verify immediately, in THIS process, rather than trusting cpSync's
		// silent return: a later step (Verify extension entry loads) is a
		// SEPARATE `node` invocation, so a copy that silently landed wrong
		// (wrong permissions, an interrupted write, cpSync's dereference
		// default missing a symlinked file) would otherwise only surface
		// there, several steps and possibly several minutes later, with a
		// generic ERR_MODULE_NOT_FOUND that gives no hint this step is the
		// actual cause.
		const destPkgJson = path.join(dest, "package.json");
		if (!fs.existsSync(destPkgJson)) {
			console.error(
				`[supply] copied ${nested} -> ${dest} but ${destPkgJson} is ` +
					"missing immediately after — cpSync silently produced an " +
					"incomplete copy",
			);
			process.exit(1);
		}
		const destPkg = JSON.parse(fs.readFileSync(destPkgJson, "utf8"));
		const destMain = path.join(dest, destPkg.main ?? "index.js");
		if (!fs.existsSync(destMain)) {
			console.error(
				`[supply] copied ${dest} has package.json but its "main" ` +
					`entry ${destMain} is missing — incomplete copy`,
			);
			process.exit(1);
		}
		console.log(
			`[supply] extracted ${EXTRACTED_VIA_OPENGSD_PI}@${destPkg.version} ` +
				`from ${OPENGSD_GSD_PI}@${gsdPiRange} -> ${dest} ` +
				`(verified ${destPkgJson} and ${destMain} both present)`,
		);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

const mode = process.argv[2];

if (mode === "--allow-pattern") {
	console.log(HOST_PROVIDED_TYPE_ONLY_PACKAGES.join("|"));
	process.exit(0);
}

if (mode === "--install") {
	const installDir = process.argv[3];
	if (!installDir) {
		console.error("[supply] --install requires a target directory argument");
		process.exit(2);
	}
	installHostProvidedPackages(installDir);
	process.exit(0);
}

if (mode !== "--install-args") {
	console.error(
		"[supply] usage: supply-host-provided-deps.mjs --install-args|--allow-pattern|--install <dir>",
	);
	process.exit(2);
}

const ranges = readPeerRanges();
requirePeerRanges(HOST_PROVIDED_RUNTIME_PACKAGES, ranges);

// Newline-delimited, not space-joined: a peer range itself can contain a
// space (e.g. an OR-form semver range like "^0.84.1 || ^0.85.0", #2586
// review F1), and every caller splits this output back into argv entries.
// Space-joining would let such a range's internal space explode into extra
// tokens under a naive word-split; a newline can never appear inside a
// single `name@range` entry, so splitting on it only ever recovers exactly
// one token per package.
console.log(
	HOST_PROVIDED_RUNTIME_PACKAGES.map((name) => `${name}@${ranges[name]}`).join(
		"\n",
	),
);
