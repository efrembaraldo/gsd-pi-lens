// Recurrence: #2940. 9183f39c6 changed release.yml's "Pin npm" step from
// `npm install -g npm@<pin>` to `npx -y npm@<pin> --version` and routed the
// INSTALL step through `npx`, but left `npm publish` bare — so the publish job
// ran Node 22's bundled npm, which has no OIDC trusted-publishing support.
// Nothing failed until the v4.1.6 release run (34530690014, 2026-09-10):
// tag and GitHub release created, then
// `npm error 404 Not Found - PUT https://registry.npmjs.org/pi-lens`.
// Recovered by #2938.
//
// The fork does not carry release.yml: it was removed per R009 (the RPC bus
// channel change decommissioned the upstream tag/tag-tracking release path).
// The fork's release-publish workflow is publish.yml, which publishes to npm
// on every CI iteration via OIDC Trusted Publishing. It protects the same
// #2940 shape with the same mechanism the pre-fix release.yml lacked — forcing
// a pinned, Trusted-Publishing-capable npm (`npm install -g npm@11.18.0`,
// OIDC added in npm 11.5.1) BEFORE any `npm publish`. This gate bends the
// historical red vector onto publish.yml's real structure.
//
// Two scans, two string policies, deliberately (the sweep-kit
// `strings: "preserve" | "blank"` distinction, applied to shell):
//   - the SATISFY direction (which step carries the pinned upgrade, which
//     version it pins) reads comment-blanked text with strings INTACT, because
//     the pinned form `npm@11.18.0` is a quoted/unquoted token, not prose;
//   - the TRIP direction (is there a bare `npm publish`) reads `lexShell`'s
//     fully lexed text, where a comment or an `echo "... npm publish ..."`
//     string cannot masquerade as a command.
// A comment quoting `npm publish` therefore neither trips the rule nor
// satisfies it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { lexShell } from "../support/workflow-shell-portability.js";

const ROOT = resolve(import.meta.dirname, "../..");
const RELEASE_WORKFLOW = ".github/workflows/publish.yml";

/** The job whose shell runs npm against the registry (the publish job). */
const GUARDED_JOB = "publish";

type Step = { name?: unknown; run?: unknown };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source: string): Workflow {
	return yaml.load(source) as Workflow;
}

function readWorkflow(relativePath: string): Workflow {
	return loadWorkflow(readFileSync(resolve(ROOT, relativePath), "utf8"));
}

/**
 * Blank shell comments, keep strings. Quote tracking is what stops a `#`
 * inside a string being read as a comment start; blanking a line too eagerly
 * can only make the SATISFY direction stricter, never let a comment pass for
 * code.
 */
function blankShellComments(run: string): string {
	return run
		.split("\n")
		.map((line) => {
			let quote: string | undefined;
			for (let index = 0; index < line.length; index++) {
				const char = line[index];
				if (quote !== undefined) {
					if (char === quote) quote = undefined;
					continue;
				}
				if (char === "'" || char === '"') {
					quote = char;
					continue;
				}
				if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
					return line.slice(0, index) + " ".repeat(line.length - index);
				}
			}
			return line;
		})
		.join("\n");
}

type WorkflowStep = { job: string; name: string; run: string; index: number };

/** Every `run:` step of the guarded job, in file order. */
function guardedSteps(workflow: Workflow): WorkflowStep[] {
	const steps: WorkflowStep[] = [];
	const list = workflow.jobs?.[GUARDED_JOB]?.steps ?? [];
	list.forEach((step, index) => {
		if (typeof step.run !== "string") return;
		steps.push({
			job: GUARDED_JOB,
			name: typeof step.name === "string" ? step.name : "(unnamed)",
			run: step.run,
			index,
		});
	});
	return steps;
}

/**
 * The pinned upgrade — `npm install -g npm@<semver>` — derived from the
 * workflow itself, never a hard-coded version. The actual publish job pins a
 * concrete Trusted-Publishing-capable npm this way before publishing.
 */
const PINNED_UPGRADE_RE = /npm\s+install\s+-g\s+npm@(\d+)\.(\d+)\.(\d+)/;

function pinnedUpgrade(
	workflow: Workflow,
): { version: string; step: WorkflowStep } | undefined {
	for (const step of guardedSteps(workflow)) {
		const version = blankShellComments(step.run).match(PINNED_UPGRADE_RE);
		if (version) {
			// Capture group 0 is the whole `npm install -g npm@11.18.0`; the
			// version is the `@`-suffixed tail. Re-derive it from the captures
			// rather than slicing, so a caller sees only the semver.
			return {
				version: `${version[1]}.${version[2]}.${version[3]}`,
				step,
			};
		}
	}
	return undefined;
}

/** The pinned upgrade, or a named failure — never a silent fallback. */
function requirePinnedUpgrade(workflow: Workflow): {
	version: string;
	step: WorkflowStep;
} {
	const pinned = pinnedUpgrade(workflow);
	if (!pinned) {
		throw new Error(
			`no \`npm install -g npm@<semver>\` upgrade in the ${GUARDED_JOB} job`,
		);
	}
	return pinned;
}

type BareNpmFinding = { job: string; step: string; verb: string };

/**
 * Every `npm <verb>` the guarded job runs. In publish.yml every `npm` call is
 * legitimate ONLY because a pinned `npm install -g npm@<semver>` has run into
 * that same PATH first — this scan names what those calls are so the ordering
 * assertion (publish strictly after the upgrade) has an exact population.
 *
 * Shape 34: the needle is npm at a COMMAND position followed by any verb, not
 * a list of the verbs we happen to know about — `npm publish`, `npm ci`, and
 * the next one someone adds all read the same.
 */
function findBareNpmInvocations(workflow: Workflow): BareNpmFinding[] {
	const findings: BareNpmFinding[] = [];
	for (const step of guardedSteps(workflow)) {
		// lexShell blanks comments AND string bodies; a quoted `npm publish` in
		// an echo cannot read as a command, and neither can a comment.
		const code = lexShell(step.run);
		for (const match of code.matchAll(/(?<![\w@.-])npm(?![\w@.-])/g)) {
			const verb =
				code
					.slice((match.index ?? 0) + match[0].length)
					.match(/^\s+([a-z][\w-]*)/)?.[1] ?? "(unknown)";
			findings.push({ job: step.job, step: step.name, verb });
		}
	}
	return findings;
}

/**
 * The publish step that actually publishes (never a `--dry-run`-only step).
 * Matched on the pinned `npm publish ... --provenance` form, so neither a
 * comment nor an `echo` mentioning the word "publish" can stand in for the
 * step the upgrade must precede.
 */
function findRealPublishStep(workflow: Workflow): WorkflowStep | undefined {
	return guardedSteps(workflow).find((step) => {
		const code = lexShell(step.run);
		return /npm\s+publish\b/.test(code) && /--provenance/.test(code);
	});
}

/** The npm version the repo declares via its packageManager field. */
function declaredNpmVersion(): string {
	const pkg = JSON.parse(
		readFileSync(resolve(ROOT, "package.json"), "utf8"),
	) as { packageManager?: string };
	const npm = pkg.packageManager ?? "";
	return npm.replace(/^npm@/, "");
}

describe("publish.yml npm pin gate (#2940, R009)", () => {
	const workflow = readWorkflow(RELEASE_WORKFLOW);

	it("keeps the guarded publish job in the scan", () => {
		// Shape 10 / #1718: a renamed job would empty this scan and every
		// assertion below would pass over nothing.
		expect(Object.keys(workflow.jobs ?? {})).toEqual(
			expect.arrayContaining([GUARDED_JOB]),
		);
		assertNonEmptyScan(
			"publish.yml pinned-npm scan",
			guardedSteps(workflow).length,
			3,
		);
	});

	it("forces npm to a pinned, concrete version before any publish", () => {
		// #2940: on an older npm (no OIDC Trusted Publishing, added in 11.5.1),
		// `npm publish --provenance` signs a Sigstore attestation but the PUT
		// carries no valid npm auth, so the registry 404s it. The upgrade must
		// be to a CONCRETE semver, never `@latest`.
		const pinned = requirePinnedUpgrade(workflow);
		expect(pinned.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(blankShellComments(pinned.step.run)).not.toMatch(/npm@latest/);
	});

	it("pins the npm version the repo actually declares (#2940 comment contract)", () => {
		// publish.yml's upgrade comment promises "the version this repo actually
		// declares"; keep the pinned upgrade and package.json's packageManager in
		// lockstep the way the historical release.yml pin was derived.
		const pinned = requirePinnedUpgrade(workflow);
		expect(pinned.version).toBe(declaredNpmVersion());
	});

	it("publishes only after the pinned npm upgrade, never before it", () => {
		const upgrade = requirePinnedUpgrade(workflow).step;
		const publish = findRealPublishStep(workflow);
		expect(
			publish,
			"no real --provenance publish step in publish job",
		).toBeDefined();
		// The pinned upgrade (npm install -g npm@<semver>) must come BEFORE the
		// --provenance publish in file order, so every `npm publish` runs the
		// pinned, Trusted-Publishing-capable npm on PATH.
		expect(publish?.index).toBeGreaterThan(upgrade.index);
	});

	it("does not read a commented or quoted npm publish as an invocation", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Prose only
        run: |
          # recovery, by hand: npx -y "npm@11.18.3" publish || npm publish
          echo "Unrolled entries remain; npm run changelog:release in the bump PR"
`);
		expect(findBareNpmInvocations(fixture)).toEqual([]);
	});

	it("reds when the publish has no pinned upgrade before it", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Publish to npm
        run: |
          npm publish --provenance --access public
`);
		expect(pinnedUpgrade(fixture)).toBeUndefined();
		expect(findRealPublishStep(fixture)).toBeDefined();
	});

	it("reds on an @latest upgrade, which cannot be called pinned", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Upgrade npm to latest
        run: npm install -g npm@latest
      - name: Publish to npm
        run: |
          if true; then npm publish --dry-run; else npm publish --provenance; fi
`);
		expect(pinnedUpgrade(fixture)).toBeUndefined();
	});

	it("does not let a commented upgrade satisfy the runtime pin", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Talks about the pin
        run: |
          # npm install -g npm@11.18.0
          echo pinned
      - name: Publish to npm
        run: |
          npm publish --provenance --access public
`);
		const upgrade = pinnedUpgrade(fixture);
		expect(upgrade?.version).toBeUndefined();
	});

	it("reds when the publish step only echoes the --provenance form", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Upgrade npm to the pinned Trusted-Publishing-capable version
        run: npm install -g npm@11.18.0
      - name: Echo-only publish
        run: echo 'npm publish --provenance --access public'
`);
		expect(pinnedUpgrade(fixture)).toBeDefined();
		expect(findRealPublishStep(fixture)).toBeUndefined();
	});

	it("derives the pinned version from the file rather than a fixed name", () => {
		const fixture = loadWorkflow(`
jobs:
  publish:
    steps:
      - name: Upgrade npm to the pinned Trusted-Publishing-capable version
        run: npm install -g npm@11.18.0
      - name: Publish to npm
        run: |
          if true; then npm publish --dry-run; else npm publish --provenance; fi
`);
		const pinned = requirePinnedUpgrade(fixture);
		expect(pinned.version).toBe("11.18.0");
		expect(findRealPublishStep(fixture)?.name).toBe("Publish to npm");
	});
});
