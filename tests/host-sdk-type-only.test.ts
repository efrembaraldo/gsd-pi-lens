import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * #1334 S6 — `@gsd/pi-coding-agent` is an OPTIONAL PEER (vendor-fork) dep,
 * never a runtime dependency. pi installs extensions with
 * `npm install --omit=dev` (peers omitted), so any *value* import of the host
 * SDK fails to resolve at user sites, and making it a real dependency drags a
 * transitive tree whose nested paths exceed Windows MAX_PATH — which breaks
 * `git clean -fdx` on `pi update`. See AGENTS.md, "Dependencies & install
 * constraints".
 *
 * This invariant was previously prose only. It is load-bearing: it is exactly
 * why pi-lens INLINES the SDK's runtime helpers (`clients/tool-event.ts`)
 * instead of importing `isToolCallEventType` / `isEditToolResult` and friends.
 * Modelled on the #402 `typescript`-runtime-free scan.
 *
 * The host SDK here is the GSD fork (`@gsd/pi-coding-agent`), a workspace
 * package that is not registry-installable (MEM002). Its types reach the build
 * through a vendor mechanism instead: `scripts/setup-types.mjs` copies
 * `dist/` into `./vendor/pi-coding-agent/`, and `tsconfig.json` maps
 * `@gsd/pi-coding-agent` onto that checkout. The type source the third test
 * asserts on is that vendored `vendor/pi-coding-agent/dist/index.d.ts`.
 */
const RUNTIME_DIRS = ["clients", "tools", "mcp", "commands"];
const ROOT_FILES = ["index.ts", "i18n.ts"];

const HOST_SDK = "@gsd/pi-coding-agent";

/**
 * `import … from "<pkg>"` — the clause is captured for type-only checking.
 * The clause excludes `;` and quotes so the lazy match cannot run backwards
 * across a preceding import statement from a different package.
 */
const STATIC_IMPORT = new RegExp(
	String.raw`import\s+([^;"']*?)\s+from\s*["']${HOST_SDK}["']`,
	"g",
);
/**
 * `import "<pkg>"` — a bare side-effect import executes the module: a runtime
 * value import with no clause (#1353 review; the STATIC_IMPORT regex requires
 * a clause + `from`, so this form needs its own pattern).
 */
const SIDE_EFFECT_IMPORT = new RegExp(String.raw`import\s*["']${HOST_SDK}["']`);
/** `import("<pkg>")` / `require("<pkg>")` — always a runtime value import. */
const DYNAMIC_IMPORT = new RegExp(
	String.raw`(?:\bimport|\brequire)\s*\(\s*["']${HOST_SDK}["']`,
);

function* walkTs(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const p = path.join(dir, entry);
		if (statSync(p).isDirectory()) {
			if (entry === "node_modules") continue;
			yield* walkTs(p);
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			yield p;
		}
	}
}

/** True when every binding in an import clause is erased at compile time. */
function isTypeOnlyClause(clause: string): boolean {
	const trimmed = clause.trim();
	// `import type { … }` / `import type X` — whole statement is type-only.
	if (/^type\b/.test(trimmed)) return true;
	// Otherwise it must be a braced list where EVERY specifier is `type X`.
	const braced = /^\{([\s\S]*)\}$/.exec(trimmed);
	if (!braced) return false;
	return braced[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.every((s) => /^type\s/.test(s));
}

function shippedSourceFiles(): string[] {
	return [
		...ROOT_FILES.map((f) => path.join(root, f)),
		...RUNTIME_DIRS.flatMap((d) => [...walkTs(path.join(root, d))]),
	];
}

describe("host SDK is imported type-only, never at runtime (#1334 S6)", () => {
	it("no shipped source file value-imports @gsd/pi-coding-agent", () => {
		const offenders: string[] = [];
		for (const file of shippedSourceFiles()) {
			const src = readFileSync(file, "utf8");
			if (!src.includes(HOST_SDK)) continue;
			const rel = path.relative(root, file).replace(/\\/g, "/");

			if (DYNAMIC_IMPORT.test(src)) {
				offenders.push(`${rel} (dynamic import/require)`);
			}
			if (SIDE_EFFECT_IMPORT.test(src)) {
				offenders.push(`${rel} (side-effect import)`);
			}
			for (const match of src.matchAll(STATIC_IMPORT)) {
				if (!isTypeOnlyClause(match[1])) {
					offenders.push(`${rel} (value import: ${match[1].trim()})`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the scan actually recognizes a value import (guards the guard)", () => {
		expect(isTypeOnlyClause("type { ExtensionAPI }")).toBe(true);
		expect(isTypeOnlyClause("{ type Theme, type ToolDefinition }")).toBe(true);
		// The exact shape S6 audited and rejected: the host's tool-result
		// discriminators are runtime functions, so importing them is a value
		// import even though they only ever narrow types.
		expect(isTypeOnlyClause("{ isEditToolResult, isReadToolResult }")).toBe(
			false,
		);
		expect(isTypeOnlyClause("{ type EditToolInput, isEditToolResult }")).toBe(
			false,
		);
		expect(isTypeOnlyClause("* as pi")).toBe(false);
		expect(DYNAMIC_IMPORT.test(`await import("${HOST_SDK}")`)).toBe(true);
		expect(DYNAMIC_IMPORT.test(`require("${HOST_SDK}")`)).toBe(true);
		expect(SIDE_EFFECT_IMPORT.test(`import "${HOST_SDK}";`)).toBe(true);
		expect(
			SIDE_EFFECT_IMPORT.test(`import type { X } from "${HOST_SDK}";`),
		).toBe(false);
	});

	it("keeps the host SDK out of runtime dependencies", () => {
		const pkg = JSON.parse(
			readFileSync(path.join(root, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
		expect(pkg.dependencies?.[HOST_SDK]).toBeUndefined();
		expect(pkg.peerDependencies?.[HOST_SDK]).toBeDefined();
		// The gsd fork is not registry-installable (MEM002), so it never appears
		// as a devDependency. Runtime types reach the build from the vendored
		// copy below — the fork's real type mechanism — not from a published
		// package. Assert that source exists so the type-only scan actually has
		// a `dist/index.d.ts` to protect (defect shape 7: a missing fork would
		// otherwise make every path mapping silently vacuous).
		expect(pkg.devDependencies?.[HOST_SDK]).toBeUndefined();
		expect(
			existsSync(
				path.join(root, "vendor", "pi-coding-agent", "dist", "index.d.ts"),
			),
		).toBe(true);
	});
});
