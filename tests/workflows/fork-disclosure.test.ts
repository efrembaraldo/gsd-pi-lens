import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fork disclosure contract guard (S02/T01).
 *
 * Verifies that the structural fork identity of this repository is visible
 * at the two entry points a fresh reader touches first: the README heading
 * stack and the CHANGELOG preamble. Both headings are treated as required
 * structural artefacts, not optional prose: their absence, relocation, or
 * emptying must surface here before any user-facing change can ship without
 * them.
 *
 * Two independent constraints per document:
 *   - position (heading lives where a fresh reader will see it first)
 *   - content  (heading carries the load-bearing fork facts)
 *
 * Each constraint lives in its own `it`, so moving the heading out of place
 * fails the position test while emptying it fails the content test, with
 * no test masking the other.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

const README_FILE_PATH = "README.md";
const CHANGELOG_FILE_PATH = "CHANGELOG.md";

const README_DISCLOSURE_HEADING = "## Fork di pi-lens";
const CHANGELOG_DISCLOSURE_HEADING =
	"## Modifiche strutturali rispetto a pi-lens";

// GitHub-style anchor for the CHANGELOG heading:
// lowercased, spaces collapsed to "-". The string here is treated as a
// literal anchor (the README link target), not as a regex, so a case-only
// substring check suffices.
const CHANGELOG_DISCLOSURE_ANCHOR = "modifiche-strutturali-rispetto-a-pi-lens";

describe("README disclosure (S02)", () => {
	const readmeText = readFileSync(resolve(REPO_ROOT, README_FILE_PATH), "utf8");

	it("places the '## Fork di pi-lens' heading between '# pi-lens' and '## What It Does'", () => {
		const rows = readmeText.split("\n");

		let titleRow = -1;
		let whatRow = -1;
		let forkRow = -1;
		for (let i = 0; i < rows.length; i++) {
			const trimmed = rows[i].trim();
			if (trimmed === "# pi-lens" && titleRow === -1) titleRow = i;
			else if (trimmed === "## What It Does" && whatRow === -1) whatRow = i;
			else if (trimmed === README_DISCLOSURE_HEADING && forkRow === -1)
				forkRow = i;
		}

		expect(
			titleRow,
			"expected '# pi-lens' title to exist in README",
		).toBeGreaterThanOrEqual(0);
		expect(
			whatRow,
			"expected '## What It Does' anchor to exist in README",
		).toBeGreaterThan(titleRow);
		expect(
			forkRow,
			"expected '## Fork di pi-lens' disclosure heading to exist in README",
		).toBeGreaterThanOrEqual(0);

		// Order: title < disclosure < What It Does. A disclosure placed after
		// the feature list is no longer the first thing a reader sees.
		expect(forkRow).toBeGreaterThan(titleRow);
		expect(forkRow).toBeLessThan(whatRow);
	});

	it("'## Fork di pi-lens' section names origin, scope, package, release, branch, CI/publish and links to CHANGELOG", () => {
		const rows = readmeText.split("\n");

		let startRow = -1;
		let endRow = rows.length;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].trim() === README_DISCLOSURE_HEADING) {
				startRow = i;
				for (let j = i + 1; j < rows.length; j++) {
					if (rows[j].startsWith("## ")) {
						endRow = j;
						break;
					}
				}
				break;
			}
		}

		expect(
			startRow,
			"expected disclosure section body to be present",
		).toBeGreaterThanOrEqual(0);
		const body = rows.slice(startRow + 1, endRow).join("\n");

		// Upstream origin: the fork must name its source repository.
		expect(
			body,
			"disclosure must name upstream origin 'apmantza/pi-lens'",
		).toMatch(/apmantza\/pi-lens/);

		// Host scope: the host packages are published under @gsd/* (not @earendil-works or @apmantza).
		expect(body, "disclosure must name host scope '@gsd/*'").toMatch(
			/@gsd\/\*/,
		);

		// Fork package: published identity on the npm registry.
		expect(
			body,
			"disclosure must name fork package '@efrembaraldo/gsd-pi-lens'",
		).toMatch(/@efrembaraldo\/gsd-pi-lens/);

		// Independent release line starting at 0.0.1.
		expect(body, "disclosure must name initial release '0.0.1'").toMatch(
			/0\.0\.1/,
		);

		// Default branch pin: the fork's branch is 'master', not 'main'.
		expect(
			body,
			"disclosure must name the fork's default branch 'master'",
		).toMatch(/\bmaster\b/);

		// Dedicated CI pipeline: the fork does not reuse upstream GitHub Actions.
		expect(body, "disclosure must mention dedicated CI").toMatch(/\bCI\b/);

		// Dedicated publish workflow: registry publish runs on this fork's own pipeline.
		expect(body, "disclosure must mention dedicated publish workflow").toMatch(
			/\bpublish\b/i,
		);

		// Link to the CHANGELOG structural section so a reader can verify the facts.
		// Anchor match is a literal substring (case-insensitive): the anchor string is a
		// compile-time constant from this module, not user input, so a substring check
		// is both sufficient and free of any dynamic-regex hazard.
		const expectedLink = "CHANGELOG.md#" + CHANGELOG_DISCLOSURE_ANCHOR;
		expect(
			body.toLowerCase(),
			"disclosure must link to the CHANGELOG structural section",
		).toContain(expectedLink.toLowerCase());
	});
});

describe("CHANGELOG fork disclosure (S02)", () => {
	const changelogText = readFileSync(
		resolve(REPO_ROOT, CHANGELOG_FILE_PATH),
		"utf8",
	);

	it("places '## Modifiche strutturali rispetto a pi-lens' before the first version heading", () => {
		const rows = changelogText.split("\n");

		let structuralRow = -1;
		let firstVersionRow = -1;
		for (let i = 0; i < rows.length; i++) {
			const trimmed = rows[i].trim();
			if (structuralRow === -1 && trimmed === CHANGELOG_DISCLOSURE_HEADING) {
				structuralRow = i;
				continue;
			}
			if (firstVersionRow === -1 && /^##\s+\[.+\]/.test(trimmed)) {
				firstVersionRow = i;
			}
		}

		expect(
			structuralRow,
			"expected '## Modifiche strutturali rispetto a pi-lens' heading in CHANGELOG",
		).toBeGreaterThanOrEqual(0);
		expect(
			firstVersionRow,
			"expected at least one '## [<version>]' heading in CHANGELOG",
		).toBeGreaterThanOrEqual(0);

		// The structural section sits in the preamble so a fresh reader
		// sees the fork identity before any release line.
		expect(structuralRow).toBeLessThan(firstVersionRow);
	});

	it("'## Modifiche strutturali rispetto a pi-lens' section names the substantive fork transformations", () => {
		const rows = changelogText.split("\n");

		let startRow = -1;
		let endRow = rows.length;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].trim() === CHANGELOG_DISCLOSURE_HEADING) {
				startRow = i;
				for (let j = i + 1; j < rows.length; j++) {
					if (rows[j].startsWith("## ")) {
						endRow = j;
						break;
					}
				}
				break;
			}
		}

		expect(
			startRow,
			"expected structural section body to be present",
		).toBeGreaterThanOrEqual(0);
		const body = rows
			.slice(startRow + 1, endRow)
			.join("\n")
			.trim();

		// Body must carry load-bearing content: an empty section passes the
		// position test and silently degrades the fork identity.
		expect(
			body.length,
			"expected structural section body to be non-empty",
		).toBeGreaterThan(0);

		// Upstream derivation: the fork traces to a specific source commit range.
		expect(
			body,
			"structural section must name upstream origin 'apmantza/pi-lens'",
		).toMatch(/apmantza\/pi-lens/);

		// Upstream history preservation: the section explains which release the
		// fork diverged from. 4.1.3 is the last upstream release preserved verbatim.
		expect(
			body,
			"structural section must name the upstream history anchor '4.1.3'",
		).toMatch(/4\.1\.3/);

		// Independent fork release line starting at 0.0.1.
		expect(body, "structural section must name fork release '0.0.1'").toMatch(
			/0\.0\.1/,
		);

		// Fork package identity + host scope.
		expect(
			body,
			"structural section must name fork package '@efrembaraldo/gsd-pi-lens'",
		).toMatch(/@efrembaraldo\/gsd-pi-lens/);
		expect(body, "structural section must name host scope '@gsd/*'").toMatch(
			/@gsd\/\*/,
		);

		// Branch pin for the dedicated CI/publish workflows.
		expect(body, "structural section must name fork branch 'master'").toMatch(
			/\bmaster\b/,
		);

		// Publish workflow uses OIDC provenance (id-token:write), no NPM_TOKEN.
		// Either token explicitly named, or the OIDC mechanism itself.
		expect(
			body,
			"structural section must mention OIDC-backed publish (id-token or OIDC)",
		).toMatch(/\b(id-token|OIDC)\b/i);

		// Three load-bearing guards for the fork transformation. Each one is
		// named in the slice plan as a verification of the fork invariants.
		expect(
			body,
			"structural section must name 'host-sdk-type-only' guard",
		).toMatch(/host-sdk-type-only/);
		expect(
			body,
			"structural section must name 'deps-centralization' guard",
		).toMatch(/deps-centralization/);
		expect(
			body,
			"structural section must name 'pi-host-contract' guard",
		).toMatch(/pi-host-contract/);
	});
});
