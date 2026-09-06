import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; uses?: string; with?: unknown };
type Job = { steps?: Step[] };
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