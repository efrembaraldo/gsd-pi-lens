import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

// Workflows disabled for fork: no automation triggers, only workflow_dispatch.
const DISABLED_WORKFLOWS = new Set([
	"merge-train-lane.yml",
	"merge-train-warden.yml",
	"labels.yml",
	"greetings.yml",
	"stale.yml",
	"stale-open-issues.yml",
	"ci-infra-kill-rerun.yml",
]);

// Workflows kept active: confermati necessari per il fork.
const KEPT_WORKFLOWS = new Set([
	"ci.yml",
	"lint.yml",
	"publish.yml",
	"install-smoke.yml",
	"compat-smoke.yml",
	"grammar-health.yml",
	"tool-smoke.yml",
	"lifecycle-smoke.yml",
	"parser-smoke.yml",
	"osv-scan.yml",
	"close-keyword-verification.yml",
	"close-keywords.yml",
	"mutation.yml",
]);

type Workflow = { name?: string; on?: unknown };

function readWorkflow(filename: string): { content: string; parsed: Workflow } {
	const content = readFileSync(resolve(WORKFLOWS_DIR, filename), "utf8");
	return { content, parsed: yaml.load(content) as Workflow };
}

describe("workflow-disposition (S01 fork policy)", () => {
	it("enumerates DISABLED and KEPT workflows consistently", () => {
		const allWorkflows = new Set(
			readdirSync(WORKFLOWS_DIR)
				.filter((f) => f.endsWith(".yml"))
				.sort(),
		);
		const defined = new Set([...DISABLED_WORKFLOWS, ...KEPT_WORKFLOWS]);
		expect(defined).toEqual(allWorkflows);
	});

	describe("DISABLED workflows", () => {
		for (const filename of Array.from(DISABLED_WORKFLOWS).sort()) {
			it(`${filename} has marker "Disabled for fork" and only workflow_dispatch trigger`, () => {
				const { content, parsed } = readWorkflow(filename);

				// Marker must exist in the content.
				expect(content).toContain("Disabled for fork");

				// The `on:` block must exist and contain only workflow_dispatch (or be empty).
				const on = parsed.on;
				expect(on).toBeDefined();
				if (typeof on === "object" && on !== null && !Array.isArray(on)) {
					const triggers = Object.keys(on as Record<string, unknown>);
					expect(triggers).toEqual(
						expect.arrayContaining(["workflow_dispatch"]),
					);
					// Ensure ONLY workflow_dispatch is present (no other triggers).
					for (const key of triggers) {
						expect(key).toBe("workflow_dispatch");
					}
				}
			});
		}
	});

	describe("KEPT workflows", () => {
		for (const filename of Array.from(KEPT_WORKFLOWS).sort()) {
			it(`${filename} does NOT contain "Disabled for fork" marker`, () => {
				const { content } = readWorkflow(filename);
				expect(content).not.toContain("Disabled for fork");
			});
		}
	});
});
