// flake-shape: real-process-spawn — the subject IS the script's actual stdout
// bytes (whether the delimiter is a real newline vs. a real space), which
// only a real child process invocation can prove; an in-process stub of
// `supply-host-provided-deps.mjs` would just re-assert whatever delimiter
// the test author typed, not what the script actually prints (#2586 review
// F1).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_PROVIDED_RUNTIME_PACKAGES } from "../../scripts/lib/host-provided-deps.mjs";

// #2586 review F1: `.github/workflows/ci.yml` reads `--install-args`'s
// stdout with a newline-only loop reading `node "$SUPPLY" --install-args`,
// which splits ONLY on newlines. `peerDependencies["@gsd/pi-tui"]`
// is an OR-form semver range ("^0.84.1 || ^0.85.0", #2586) that itself
// contains a space — the old space-joined `--install-args` output let a
// naive word-split (bash's default IFS, or the `read -ra ... <<< "$(...)"`
// this replaced) explode that single `name@range` entry into THREE argv
// tokens, so `npm install ... "${HOST_PKGS[@]}"` failed with
// `npm ERR! notarget No matching version found for undefined@^0.85.0`
// (reproduced verbatim against this exact tree before the fix). This test
// pins the actual property every caller depends on: the output splits on
// NEWLINES ONLY into exactly one token per runtime package, regardless of
// whether a package's range itself contains a space.
const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const scriptPath = path.join(root, "scripts", "supply-host-provided-deps.mjs");

function runInstallArgs(): string {
	return execFileSync(process.execPath, [scriptPath, "--install-args"], {
		cwd: root,
		encoding: "utf8",
	});
}

describe("supply-host-provided-deps.mjs --install-args (#2586 review F1)", () => {
	it("lists at least one runtime package to guard", () => {
		// Guards the guard: an emptied HOST_PROVIDED_RUNTIME_PACKAGES would make
		// the token-count assertion below vacuously pass.
		expect(HOST_PROVIDED_RUNTIME_PACKAGES.length).toBeGreaterThan(0);
	});

	it("splits into exactly one token per runtime package with newline-delimited workflow input", () => {
		const output = runInstallArgs();
		// Mirrors the workflow loop: split on newlines only, drop the trailing empty
		// entry a final newline would otherwise introduce.
		const tokens = output.split("\n").filter((line) => line.length > 0);
		expect(
			tokens.length,
			`expected exactly ${HOST_PROVIDED_RUNTIME_PACKAGES.length} newline-delimited entries, got: ${JSON.stringify(tokens)}`,
		).toBe(HOST_PROVIDED_RUNTIME_PACKAGES.length);
	});

	it("preserves a range's internal space as ONE token, not split further", () => {
		// The regression this guards: a peer range containing a space (like the
		// pre-merge pi-tui OR-form range, #2586) must survive as a single argv
		// entry once split on newlines — proving the delimiter choice, not just
		// the count, is correct (a coincidental count match wouldn't catch a
		// shuffled split). M003/S02's v4.1.6 upstream merge deliberately bumped
		// @gsd/pi-tui's declared range to a clean "^1.19.0" (no space), so the
		// REAL package.json no longer has a naturally-occurring space to prove
		// this against — the guard now needs a synthetic fixture package.json,
		// carrying an OR-form range shaped exactly like the one #2586 fixed, to
		// keep exercising the real behavior this test exists to pin.
		const tui = "@gsd/pi-tui";
		const range = "^1.19.0 || ^2.0.0";
		expect(
			range.includes(" "),
			"this guard only proves something when the fixture range actually contains a space",
		).toBe(true);

		// The script resolves its OWN package.json by walking up from
		// import.meta.url, not from the invoking process's cwd — so proving
		// this against a synthetic range means copying the script (and the
		// lib module it imports) into an isolated tree with a fixture
		// package.json at the matching relative path, not just chdir'ing.
		const tmpRoot = fs.mkdtempSync(
			path.join(fs.realpathSync(os.tmpdir()), "supply-deps-"),
		);
		try {
			fs.mkdirSync(path.join(tmpRoot, "scripts", "lib"), { recursive: true });
			fs.copyFileSync(
				scriptPath,
				path.join(tmpRoot, "scripts", "supply-host-provided-deps.mjs"),
			);
			fs.copyFileSync(
				path.join(root, "scripts", "lib", "host-provided-deps.mjs"),
				path.join(tmpRoot, "scripts", "lib", "host-provided-deps.mjs"),
			);
			const realPkg = JSON.parse(
				fs.readFileSync(path.join(root, "package.json"), "utf8"),
			) as { peerDependencies?: Record<string, string> };
			fs.writeFileSync(
				path.join(tmpRoot, "package.json"),
				JSON.stringify({
					peerDependencies: { ...realPkg.peerDependencies, [tui]: range },
				}),
			);

			const output = execFileSync(
				process.execPath,
				[
					path.join(tmpRoot, "scripts", "supply-host-provided-deps.mjs"),
					"--install-args",
				],
				{ cwd: tmpRoot, encoding: "utf8" },
			);
			const tokens = output.split("\n").filter((line) => line.length > 0);
			expect(tokens).toContain(`${tui}@${range}`);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
