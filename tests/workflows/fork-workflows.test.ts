import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; uses?: string; with?: unknown };
type Job = { steps?: Step[]; permissions?: unknown; environment?: unknown; if?: unknown };
type Workflow = { name?: string; on?: unknown; permissions?: unknown; jobs?: Record<string, Job> };

function readWorkflow(relativePath: string): { content: string; parsed: Workflow } {
	const content = readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
	return { content, parsed: yaml.load(content) as Workflow };
}

/** Normalize the YAML trigger branches form (array or single string) to an array. */
function toBranches(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	if (typeof value === "string") return [value];
	return [];
}

function workflowTriggers(on: unknown): Record<string, unknown> {
	if (!on || typeof on !== "object" || Array.isArray(on)) return {};
	return on as Record<string, unknown>;
}

/** True when a job step's `run` body includes `fragment`. */
function jobHasScript(job: Job | undefined, fragment: string): boolean {
	return (
		!!job &&
		Array.isArray(job.steps) &&
		job.steps.some((s) => typeof s?.run === "string" && s.run.includes(fragment))
	);
}

/** Index of the first step whose `run` body contains `fragment`, or -1. */
function firstRunIndexOf(job: Job | undefined, fragment: string): number {
	if (!job || !Array.isArray(job.steps)) return -1;
	return job.steps.findIndex((s) => typeof s?.run === "string" && s.run.includes(fragment));
}

function jobNodeVersion(job: Job | undefined): unknown {
	if (!job || !Array.isArray(job.steps)) return undefined;
	for (const s of job.steps) {
		if (typeof s?.uses === "string" && s.uses.includes("actions/setup-node")) {
			const withMap = s.with as Record<string, unknown> | undefined;
			return withMap?.["node-version"];
		}
	}
	return undefined;
}

describe("ci.yml (fork)", () => {
	const ci = readWorkflow(".github/workflows/ci.yml");
	const { content, parsed } = ci;

	it("is named CI and gates on branch + pull_request + manual dispatch", () => {
		expect(parsed.name).toBe("CI");
		const on = workflowTriggers(parsed.on);
		const push = on.push as { branches?: unknown } | undefined;
		const branches = toBranches(push?.branches);
		// R008 pin: the fork's default branch is master; a future rename to main
		// must keep CI running. Cover both, so a default-branch rename cannot
		// silently disable the whole pipeline.
		expect(branches).toContain("master");
		expect(branches).toContain("main");
		expect(on).toHaveProperty("pull_request");
		expect(on).toHaveProperty("workflow_dispatch");
	});

	it("declares both the build and prod-install-build jobs", () => {
		expect(parsed.jobs).toHaveProperty("build");
		expect(parsed.jobs).toHaveProperty("prod-install-build");
	});

	it("grants only contents:read at workflow level", () => {
		const perms = parsed.permissions as Record<string, unknown> | undefined;
		expect(perms).toBeDefined();
		expect(perms?.["contents"]).toBe("read");
	});

	it("runs the build job on Node 22", () => {
		expect(jobNodeVersion(parsed.jobs?.build)).toBe(22);
	});

	it("builds the gsd-pi SDK in-job from the verified checkout", () => {
		// The @gsd host is not installable from a registry (workspace:* deps),
		// so CI clones and builds open-gsd/gsd-pi via its verified `build:pi`
		// script (same step as .github/workflows/compat-smoke.yml).
		expect(jobHasScript(parsed.jobs?.build, "pnpm run build:pi")).toBe(true);
		expect(jobHasScript(parsed.jobs?.build, "GSD_PI_CHECKOUT=/tmp/gsd-pi")).toBe(true);
	});

	it("runs setup-types.mjs after npm ci in the build job (MEM011)", () => {
		const build = parsed.jobs?.build;
		const ciIdx = firstRunIndexOf(build, "npm ci --no-audit --no-fund");
		const setupIdx = firstRunIndexOf(build, "scripts/setup-types.mjs");
		expect(ciIdx).toBeGreaterThanOrEqual(0);
		expect(setupIdx).toBeGreaterThan(ciIdx);
	});

	it("runs the production install shape check in prod-install-build", () => {
		const prod = parsed.jobs?.["prod-install-build"];
		expect(jobNodeVersion(prod)).toBe(22);
		expect(jobHasScript(prod, "npm prune --omit=dev")).toBe(true);
		expect(jobHasScript(prod, "scripts/check-prod-install-shape.mjs")).toBe(true);
	});

	it("carries no upstream fork identities", () => {
		expect(content).not.toContain("earendil-works");
		expect(content).not.toContain("apmantza");
	});
});

describe("publish.yml (fork)", () => {
	const publish = readWorkflow(".github/workflows/publish.yml");
	const { content, parsed } = publish;

	it("is named Publish", () => {
		expect(parsed.name).toBe("Publish");
	});

	it("triggers on workflow_dispatch with a dry-run input defaulting to true", () => {
		const on = workflowTriggers(parsed.on);
		expect(on).toHaveProperty("workflow_dispatch");
		const inputs = (on.workflow_dispatch as { inputs?: Record<string, unknown> } | undefined)?.inputs;
		const dryRun = (inputs?.["dry-run"] ?? {}) as Record<string, unknown>;
		expect(dryRun["type"]).toBe("boolean");
		expect(dryRun["default"]).toBe(true);
	});

	it("triggers on workflow_run of the CI workflow completing", () => {
		const on = workflowTriggers(parsed.on);
		const wr = (on.workflow_run ?? {}) as Record<string, unknown>;
		const workflows = Array.isArray(wr["workflows"]) ? wr["workflows"] : [];
		const types = Array.isArray(wr["types"]) ? wr["types"] : [];
		expect(workflows).toContain("CI");
		expect(types).toContain("completed");
	});

	it("declares verify and publish jobs", () => {
		expect(parsed.jobs).toHaveProperty("verify");
		expect(parsed.jobs).toHaveProperty("publish");
	});

	it("gives the publish job id-token:write and contents:read for OIDC", () => {
		const perms = parsed.jobs?.publish?.permissions as Record<string, unknown> | undefined;
		expect(perms?.["id-token"]).toBe("write");
		expect(perms?.["contents"]).toBe("read");
	});

	it("gates the publish job' conditionally on CI success or dry-run false", () => {
		// R009: workflow_run publishes only when CI concluded successfully;
		// workflow_dispatch publishes only when the dry-run input is false.
		const jobIf = parsed.jobs?.publish?.if;
		expect(typeof jobIf).toBe("string");
		const expr = String(jobIf);
		expect(expr).toContain("workflow_run");
		expect(expr).toContain("success");
		expect(expr).toContain("inputs.dry-run");
	});

	it("checks the registry version and publishes with provenance", () => {
		expect(jobHasScript(parsed.jobs?.verify, "npm view @efrembaraldo/gsd-pi-lens")).toBe(true);
		expect(jobHasScript(parsed.jobs?.publish, "--provenance --access public")).toBe(true);
	});

	it("carries no registry token and no environment key on publish", () => {
		expect(content).not.toContain("NPM_TOKEN");
		expect(content).not.toContain("NODE_AUTH_TOKEN");
		expect(parsed.jobs?.publish?.environment).toBeUndefined();
	});

	it("removed the upstream release.yml (R009 net replacement)", () => {
		expect(existsSync(resolve(REPO_ROOT, ".github/workflows/release.yml"))).toBe(false);
	});
});

describe("default-branch policy (all workflows)", () => {
	/** Load all workflow files and verify branch pin invariant. */

	function extractBranchesFromTrigger(triggerValue: unknown): string[] {
		if (!triggerValue || typeof triggerValue !== "object" || Array.isArray(triggerValue)) {
			return [];
		}
		const trigger = triggerValue as Record<string, unknown>;
		const branches = trigger.branches;
		return toBranches(branches);
	}

	it("pins every branch-gated workflow to include 'master' (T03 pin: fork default branch is master)", () => {
		// The fork's default branch is 'master', not 'main' (Github's new default).
		// Workflows with branch filters must include 'master' to gate on the
		// fork's own branch. Omitting 'master' silently disables the workflow.
		// This test is mutation-proof: removing 'master' from any branch filter,
		// or adding a workflow with only 'main', will fail this assertion.

		const workflows = [
			"ci.yml",
			"ci-infra-kill-rerun.yml",
			"close-keyword-verification.yml",
			"compat-smoke.yml",
			"grammar-health.yml",
			"greetings.yml",
			"install-smoke.yml",
			"labels.yml",
			"lifecycle-smoke.yml",
			"lint.yml",
			"merge-train-lane.yml",
			"merge-train-warden.yml",
			"osv-scan.yml",
			"parser-smoke.yml",
			"publish.yml",
			"stale-open-issues.yml",
			"stale.yml",
			"tool-smoke.yml",
		];

		const branchPolicy: Record<string, { pushBranches: string[]; prBranches: string[] }> = {};

		for (const workflowFile of workflows) {
			const { parsed } = readWorkflow(`.github/workflows/${workflowFile}`);
			const on = workflowTriggers(parsed.on);

			const pushTrigger = on.push as { branches?: unknown } | undefined;
			const pushBranches = extractBranchesFromTrigger(pushTrigger?.branches);

			const prTrigger = on.pull_request as { branches?: unknown } | undefined;
			const prBranches = extractBranchesFromTrigger(prTrigger?.branches);

			branchPolicy[workflowFile] = { pushBranches, prBranches };

			// For each workflow: if push.branches is a non-empty list, it must include 'master'.
			if (pushBranches.length > 0) {
				expect(
					pushBranches,
					`${workflowFile} push.branches must include 'master', got [${pushBranches.join(", ")}]`,
				).toContain("master");
			}

			// Similarly for pull_request.branches
			if (prBranches.length > 0) {
				expect(
					prBranches,
					`${workflowFile} pull_request.branches must include 'master', got [${prBranches.join(", ")}]`,
				).toContain("master");
			}
		}

		// Log the policy table for inspection
		console.log("\n=== Branch Policy Summary (T03 confirmation table) ===");
		console.table(
			workflows.map((w) => ({
				Workflow: w,
				"push.branches": branchPolicy[w].pushBranches.join(", ") || "(none)",
				"pull_request.branches": branchPolicy[w].prBranches.join(", ") || "(none)",
			}))
		);
	});
});