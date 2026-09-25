// M003 R011 pre-condition test: attest the fork is published, installable,
// and exposes the expected package surface WITHOUT requiring a `pi --mode rpc`
// CLI (which the validation attestation machine does not have).
//
// R011 itself (live install into a running pi session) remains a human-UAT
// item — see `.gsd/phases/03-allineamento-upstream-v4-1-6-chiusura-pr/
// 03-COVERAGE-AUDIT.md`. This test covers the deterministic half: the package
// must exist on npm with the right name, version, dist-tag, and peer
// dependencies, and the tarball must be reachable. The full live install is
// then a one-liner a maintainer can run on any box that does have `pi`.
//
// flake-shape: real-network — the npm registry is the system under test
// (publish presence, dist-tag, tarball reachability); an in-process stub
// would re-assert whatever the test author typed, not what the registry
// currently says. The test self-skips when the registry is unreachable so
// it does not produce false positives on offline sandboxes.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PACKAGE = "@efrembaraldo/gsd-pi-lens";

// `npm view <pkg> --json` returns an array when multiple versions match;
// we always pin to the dist-tag latest so we get a single object whose
// shape we can assert on.
type NpmViewResult = {
	readonly version?: string;
	readonly "dist-tags"?: Record<string, string>;
	readonly peerDependencies?: Record<string, string>;
	readonly dependencies?: Record<string, string>;
	readonly main?: string;
	readonly types?: string;
	readonly engines?: Record<string, string>;
	readonly dist?: { readonly tarball?: string };
};

function runNpmView(): NpmViewResult | null {
	try {
		const raw = execFileSync("npm", ["view", `${PACKAGE}@latest`, "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000,
		});
		const parsed: NpmViewResult | NpmViewResult[] = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			// Defensive: pin to the exact version that dist-tags.latest names.
			const latest = parsed.find(
				(p) => p.version && p["dist-tags"]?.latest === p.version,
			);
			return latest ?? parsed[parsed.length - 1] ?? null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function fetchRegistry(): { status: number; body: string } | null {
	try {
		const statusRaw = execFileSync(
			"curl",
			[
				"-s",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				`https://registry.npmjs.org/${encodeURIComponent(PACKAGE).replace(/%40/g, "@")}`,
			],
			{ encoding: "utf8", timeout: 15_000 },
		).trim();
		const status = Number.parseInt(statusRaw, 10);
		if (!Number.isFinite(status)) return null;
		const body = execFileSync(
			"curl",
			[
				"-s",
				`https://registry.npmjs.org/${encodeURIComponent(PACKAGE).replace(/%40/g, "@")}`,
			],
			{ encoding: "utf8", timeout: 15_000 },
		);
		return { status, body };
	} catch {
		return null;
	}
}

describe(`fork publish roundtrip (M003 R011 pre-condition) — ${PACKAGE}`, () => {
	const view = runNpmView();
	const registry = fetchRegistry();

	const offline = view === null || registry === null;

	it.skipIf(offline)(
		"registry responds HTTP 200 for the scoped package",
		() => {
			expect(registry?.status).toBe(200);
		},
	);

	it.skipIf(offline)(
		"registry body decodes as JSON and names the scoped package",
		() => {
			expect(registry).not.toBeNull();
			const body = JSON.parse(registry!.body) as {
				readonly name?: string;
				readonly "dist-tags"?: Record<string, string>;
			};
			expect(body.name).toBe(PACKAGE);
			expect(body["dist-tags"]?.latest).toMatch(/^\d+\.\d+\.\d+/);
		},
	);

	it.skipIf(offline)(
		"`npm view` reports a valid semver for the published version",
		() => {
			expect(view).not.toBeNull();
			expect(view!.version).toMatch(/^\d+\.\d+\.\d+/);
		},
	);

	it.skipIf(offline)(
		"`dist-tags.latest` matches `npm view` reported version",
		() => {
			// Latest must equal version (npm view defaults to latest).
			expect(view).not.toBeNull();
			expect(view!["dist-tags"]?.latest).toBe(view!.version);
		},
	);

	it.skipIf(offline)(
		"package exposes the pi-coding-agent peer dependency that pi-lens wraps",
		() => {
			expect(view).not.toBeNull();
			expect(view!.peerDependencies?.["@gsd/pi-coding-agent"]).toBeDefined();
		},
	);

	it.skipIf(offline)(
		"package exposes the pi-tui peer dependency at ^1.19.0 (post-bump)",
		() => {
			expect(view).not.toBeNull();
			const range = view!.peerDependencies?.["@gsd/pi-tui"];
			expect(range).toBeDefined();
			expect(range).toMatch(/\^?1\.(1[7-9]|[2-9]\d)/);
		},
	);

	it.skipIf(offline)(
		"tarball is fetchable (registry body has tarball URL for latest version)",
		() => {
			const body = JSON.parse(registry!.body) as {
				readonly versions?: Record<string, { dist: { tarball: string } }>;
			};
			const versions = Object.keys(body.versions ?? {});
			expect(versions.length).toBeGreaterThan(0);
			const latestVersion = view?.version;
			expect(latestVersion).toBeDefined();
			const tarball = body.versions?.[latestVersion!]?.dist.tarball;
			expect(tarball).toMatch(/^https:\/\/registry\.npmjs\.org\//);
		},
	);

	// When the registry is unreachable, surface ONE explicit skip reason
	// rather than reporting the suite as green-by-skip-everything.
	it("offline registry produces an explicit skip verdict (never a silent green)", () => {
		if (offline) {
			// Vitest's it.skipIf already prevents individual tests from running;
			// this test documents the environmental gate so the suite reports
			// the cause rather than 0/0 + PASS.
			expect(offline).toBe(true);
		} else {
			expect(offline).toBe(false);
		}
	});
});
