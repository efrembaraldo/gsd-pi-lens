import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	HOST_BOM_CODE_POINT,
	HOST_EDIT_DIFF_SDK_FLOOR,
	HOST_SMART_DOUBLE_QUOTES,
	HOST_SMART_SINGLE_QUOTES,
	HOST_SPECIAL_SPACES,
	HOST_UNICODE_DASHES,
} from "../../clients/host-edit-normalize.js";

/**
 * Drift guard for the vendored host normalization ladder (#257). The host SDK is
 * type-only at runtime, so clients/host-edit-normalize.ts COPIES the host's
 * fuzzy-match code-point sets. This test re-reads the host source from devDeps
 * and fails if the host changes its ladder, so the copy can't silently rot.
 * The host source is read from the vendored `vendor/pi-coding-agent` copy.
 */

// The host SDK's compiled `.js` + `package.json` are vendored under `vendor/`
// by `scripts/setup-types.mjs` (a fork of gsd's `packages/pi-coding-agent`,
// the gsd-bundled `@gsd/pi-coding-agent`). Read the vendored files directly
// rather than through node_modules — the SDK's `exports` map blocks subpath
// + package.json resolution.
function hostPackageDir(): string {
	const dir = path.resolve("vendor", "pi-coding-agent");
	if (!fs.existsSync(path.join(dir, "package.json"))) {
		throw new Error(
			`run node scripts/setup-types.mjs — missing vendored host SDK at ${dir}`,
		);
	}
	return dir;
}

function hostEditDiffSource(): string {
	return fs.readFileSync(
		path.join(hostPackageDir(), "dist/core/tools/edit-diff.js"),
		"utf-8",
	);
}

// 0.85.1 extracted the BOM split/strip primitive out of edit-diff.js into a
// shared utils module (`splitBom` in utils/text.js). 1.19.x (M003/S02's
// upstream merge) folded it back into edit-diff.js directly, renamed to
// `stripBom` — utils/text.js no longer exists in this host version. The
// primitive's exact HOME has moved twice now; only its behavior (the BOM
// code-point check) is what this guard actually needs to track.

// Slice out ONE named top-level `export function <name>(...) { ... }`'s own
// source, bounded by the next top-level `export function`/`export const`/EOF
// -- so an assertion against the slice can't be satisfied by a SIBLING
// declaration (e.g. a hypothetical `legacyStripBom` keeping the old literal
// while the real `stripBom` drifts to something else). Good enough for this
// file's flat, unminified shape; not a general JS parser.
function sliceExportedFunction(source: string, name: string): string {
	const startMarker = `export function ${name}(`;
	const start = source.indexOf(startMarker);
	if (start === -1) {
		throw new Error(`could not find "${startMarker}" in host source`);
	}
	// `export ` is OPTIONAL in the boundary: a non-exported sibling declared
	// right after the target (e.g. an unexported `function legacySplitBom`
	// kept for a deprecation window) must ALSO terminate the slice, or its
	// body gets swallowed into the target's captured source — the whole
	// point of scoping the assertion (#2586 review round 3, F4-residual).
	const nextDeclMatch = /\n(?:(?:export )?(?:function|const)\b)/.exec(
		source.slice(start + startMarker.length),
	);
	const end = nextDeclMatch
		? start + startMarker.length + nextDeclMatch.index
		: source.length;
	return source.slice(start, end);
}

// Re-encode a code point the way the host hard-codes it: \uXXXX, 4 hex digits,
// uppercase letters (matches the host source, e.g. ‚,  , ﻿).
const esc = (codePoint: number) =>
	`\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

describe("host-edit-normalize sync (host source drift guard)", () => {
	const src = hostEditDiffSource();

	it("installed host SDK is at or above the pinned floor", () => {
		const installed: string = JSON.parse(
			fs.readFileSync(path.join(hostPackageDir(), "package.json"), "utf-8"),
		).version;
		const toParts = (v: string) =>
			v.split(".").map((n) => Number.parseInt(n, 10));
		const [im, in_, ip] = toParts(installed);
		const [fm, fn, fp] = toParts(HOST_EDIT_DIFF_SDK_FLOOR);
		const ge = im > fm || (im === fm && (in_ > fn || (in_ === fn && ip >= fp)));
		expect(
			ge,
			`installed ${installed} < pinned floor ${HOST_EDIT_DIFF_SDK_FLOOR}`,
		).toBe(true);
	});

	it("host still applies the NFKC + per-line trimEnd ladder", () => {
		expect(src).toContain('.normalize("NFKC")');
		expect(src).toContain("trimEnd()");
	});

	it("host smart-quote / dash code-point sets match the vendored copy", () => {
		expect(src).toContain(`[${HOST_SMART_SINGLE_QUOTES.map(esc).join("")}]`);
		expect(src).toContain(`[${HOST_SMART_DOUBLE_QUOTES.map(esc).join("")}]`);
		expect(src).toContain(`[${HOST_UNICODE_DASHES.map(esc).join("")}]`);
	});

	it("host special-space class (range-encoded) matches the vendored copy", () => {
		// Host encodes U+2002..U+200A as a range; assert the boundaries + the
		// NBSP / narrow-NBSP / math-space / ideographic-space anchors.
		const first = HOST_SPECIAL_SPACES[0]; // U+00A0
		const rangeLo = 0x2002;
		const rangeHi = 0x200a;
		const tail = [0x202f, 0x205f, 0x3000];
		expect(src).toContain(
			`[${esc(first)}${esc(rangeLo)}-${esc(rangeHi)}${tail.map(esc).join("")}]`,
		);
		// And our flattened copy spans exactly that inclusive range + tail.
		const expected = [
			first,
			...Array.from({ length: rangeHi - rangeLo + 1 }, (_, i) => rangeLo + i),
			...tail,
		];
		expect(HOST_SPECIAL_SPACES).toEqual(expected);
	});

	it("host still exports the line-ending primitives we vendored", () => {
		expect(src).toContain("export function detectLineEnding");
		expect(src).toContain("export function normalizeToLF");
		expect(src).toContain("export function restoreLineEndings");
	});

	it("host still strips BOM via stripBom, and stripBom's own body matches our vendored copy", () => {
		// 1.19.x folded the primitive back into edit-diff.js itself, renamed
		// `splitBom` -> `stripBom` — assert it's still a real top-level
		// export here (not re-inlined as a bare `content.startsWith(BOM)`,
		// which would silently drop the shared primitive), then assert the
		// actual code-point check against stripBom's own body.
		expect(src).toContain("export function stripBom(");
		expect(src).toContain("stripBom(");
		// Scoped to stripBom's OWN body, not "anywhere in edit-diff.js": a
		// sibling function (e.g. a hypothetical legacyStripBom) keeping the
		// old literal while the REAL stripBom drifts to something else must
		// NOT satisfy this assertion.
		const stripBomBody = sliceExportedFunction(src, "stripBom");
		expect(stripBomBody).toContain(`startsWith("${esc(HOST_BOM_CODE_POINT)}")`);
	});

	it("host match decision is still exact-then-fuzzy, counted in fuzzy space", () => {
		// Guards hostWouldApplyOldText's replica of fuzzyFindText + countOccurrences.
		expect(src).toContain("export function fuzzyFindText");
		// exact match attempted first
		expect(src).toContain("content.indexOf(oldText)");
		// then fuzzy match in normalized space
		expect(src).toContain("normalizeForFuzzyMatch(content)");
		expect(src).toContain("normalizeForFuzzyMatch(oldText)");
		// duplicate count is taken in fuzzy space (split length - 1)
		expect(src).toContain("fuzzyContent.split(fuzzyOldText).length - 1");
	});
});
