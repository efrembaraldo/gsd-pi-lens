import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EXPANSION_LIMIT_LINES,
	tryExpandRead,
} from "../../clients/read-expansion.js";
import {
	_resetMarkdownFrontmatterAlwaysReadCacheForTests,
} from "../../clients/runtime-config.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

function node(
	type: string,
	startRow: number,
	endRow: number,
	children: any[] = [],
	text = type,
) {
	return {
		type,
		text,
		children,
		startPosition: { row: startRow, column: 0 },
		endPosition: { row: endRow, column: 0 },
		parent: null as any,
	};
}

/**
 * Build a mock node tree with parent references wired up.
 * Required for ancestry chain tests since buildAncestryChain walks node.parent.
 */
function nodeTree(
	type: string,
	startRow: number,
	endRow: number,
	children: ReturnType<typeof node>[] = [],
	text = type,
): ReturnType<typeof node> {
	const n = node(type, startRow, endRow, children, text);
	for (const child of children) {
		child.parent = n;
		wireParents(child);
	}
	return n;
}

function wireParents(n: any): void {
	for (const child of n.children ?? []) {
		child.parent = n;
		wireParents(child);
	}
}

/**
 * Stand-in for the shared client. Expansion resolves its enclosing node INSIDE
 * `withParsedTree`'s callback (#417), so the stub runs `consume` on the mock tree.
 */
function stubClient(tree: unknown) {
	return {
		init: async () => true,
		withParsedTree: async (
			_filePath: string,
			_languageId: string,
			_content: string | undefined,
			consume: (tree: any) => unknown,
		) => ({ parsed: true as const, value: consume(tree) }),
	};
}

function unusedClient(reason: string) {
	return {
		init: async () => {
			throw new Error(reason);
		},
		withParsedTree: async () => {
			throw new Error(reason);
		},
	};
}

describe("EXPANSION_LIMIT_LINES", () => {
	it("is 100", () => {
		expect(EXPANSION_LIMIT_LINES).toBe(100);
	});

	it("expansion fires for reads at the limit (100 lines)", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-limit-");
		try {
			const lines =
				Array.from({ length: 110 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, lines);
			const tree = {
				rootNode: node("program", 0, 109, [
					node("function_declaration", 0, 109, [
						node("identifier", 0, 0, [], "bigFn"),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			// Request exactly EXPANSION_LIMIT_LINES — should expand
			const result = await tryExpandRead(
				filePath,
				50,
				100,
				110,
				tsClient as any,
			);
			expect(result).toBeDefined();
		} finally {
			env.cleanup();
		}
	});

	it("expansion does not fire for reads above the limit (101 lines)", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-over-");
		try {
			const lines =
				Array.from({ length: 110 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, lines);
			const tsClient = unusedClient("should not be called");
			const result = await tryExpandRead(
				filePath,
				1,
				101,
				110,
				tsClient as any,
			);
			expect(result).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("tryExpandRead", () => {
	it("expands when the requested offset is inside a symbol", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 1, 4, [
						node("identifier", 1, 1, [], "demo"),
					]),
				]),
			};
			const tsClient = stubClient(tree);

			const result = await tryExpandRead(filePath, 3, 1, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 2,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});

	it("expands overlapping reads without dropping originally requested lines", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-overlap-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 2, 4, [
						node("identifier", 2, 2, [], "demo"),
					]),
				]),
			};
			const tsClient = stubClient(tree);

			const result = await tryExpandRead(filePath, 2, 2, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 3,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});

	it("ancestry is undefined when enclosing symbol has no matching ancestors", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-noancestry-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			// function_declaration is at root — no enclosing parent of the same types
			const tree = {
				rootNode: nodeTree("program", 0, 5, [
					nodeTree("function_declaration", 1, 4, [
						node("identifier", 1, 1, [], "topLevel"),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			const result = await tryExpandRead(filePath, 3, 1, 6, tsClient as any);
			expect(result).toBeDefined();
			expect(result?.ancestry).toBeUndefined();
			expect(result?.enclosingSymbol.name).toBe("topLevel");
		} finally {
			env.cleanup();
		}
	});

	it("ancestry is populated outermost-first when method is inside a class", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-ancestry-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
			);
			// class_declaration (0-11) > method_definition (2-9) > arrow inner read at row 5
			const tree = {
				rootNode: nodeTree("program", 0, 11, [
					nodeTree("class_declaration", 0, 11, [
						node("identifier", 0, 0, [], "MyClass"),
						nodeTree("method_definition", 2, 9, [
							node("identifier", 2, 2, [], "myMethod"),
						]),
					]),
				]),
			};
			const tsClient = stubClient(tree);
			const result = await tryExpandRead(filePath, 6, 1, 12, tsClient as any);
			expect(result).toBeDefined();
			expect(result?.enclosingSymbol.name).toBe("myMethod");
			expect(result?.enclosingSymbol.kind).toBe("method_definition");
			// class_declaration is the outer ancestor
			expect(result?.ancestry).toHaveLength(1);
			expect(result?.ancestry?.[0]).toMatchObject({
				name: "MyClass",
				kind: "class_declaration",
			});
		} finally {
			env.cleanup();
		}
	});

	it("expands markdown reads to the enclosing section", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-md-");
		try {
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(
				filePath,
				"# Title\nline2\nline3\n## Section A\nline5\nline6\n## Section B\nline8\n",
			);
			const tsClient = unusedClient("should not be called for markdown");

			// Read inside Section A (line 5), should expand to lines 4-6
			const result = await tryExpandRead(filePath, 5, 1, 8, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 4,
				newLimit: 3,
				enclosingSymbol: {
					name: "Section A",
					kind: "markdown_section",
					startLine: 4,
					endLine: 6,
				},
			});

			// Read already covers the whole section — no expansion
			const noExpand = await tryExpandRead(filePath, 4, 3, 8, tsClient as any);
			expect(noExpand).toBeUndefined();

			// Read inside top-level heading — expands to the whole top-level section
			const topResult = await tryExpandRead(filePath, 2, 1, 8, tsClient as any);
			expect(topResult).toMatchObject({
				newOffset: 1,
				newLimit: 8,
				enclosingSymbol: {
					name: "Title",
					kind: "markdown_section",
					startLine: 1,
					endLine: 8,
				},
			});
		} finally {
			env.cleanup();
		}
	});
});

/**
 * S06: coverage gain for the markdown read-guard.
 *
 * Slice S06 extends `tryExpandMarkdownSection` to fold a YAML frontmatter
 * block (top of file, `---` … `---`) and any adjacent markdown table rows
 * (separator `| --- | --- |` immediately above/below the heading-derived
 * range) into the enclosing `enclosingSymbol`. The toggle
 * `readGuard.markdown.frontmatterAlwaysRead` defaults to `true` and is read
 * per-call through the lazy memoised `getMarkdownFrontmatterAlwaysRead()`
 * (`clients/runtime-config.ts`). The tests below configure that knob through
 * the same path the runtime uses: a real `~/.pi-lens/config.json` shim pointed
 * at via `PI_LENS_CONFIG_PATH`, paired with the explicit
 * `_resetMarkdownFrontmatterAlwaysReadCacheForTests()` so the lazy cache
 * re-reads the file before each case (mirrors `runtime-config.test.ts`'s
 * `getRunnerTimeoutFloorMs` pattern).
 */
describe("S06 tryExpandRead — markdown frontmatter and adjacent table coverage", () => {
	let savedConfigPath: string | undefined;
	let tmpHome: string | null = null;

	function arrange(config: Record<string, unknown> | null): string {
		if (tmpHome !== null) {
			removeTempDirSync(tmpHome);
		}
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-read-expansion-s06-"));
		const configPath = path.join(tmpHome, "config.json");
		if (config !== null) {
			fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
		}
		process.env.PI_LENS_CONFIG_PATH = configPath;
		_resetMarkdownFrontmatterAlwaysReadCacheForTests();
		return configPath;
	}

	beforeEach(() => {
		savedConfigPath = process.env.PI_LENS_CONFIG_PATH;
		_resetMarkdownFrontmatterAlwaysReadCacheForTests();
	});

	afterEach(() => {
		if (savedConfigPath === undefined) {
			delete process.env.PI_LENS_CONFIG_PATH;
		} else {
			process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
		}
		_resetMarkdownFrontmatterAlwaysReadCacheForTests();
		if (tmpHome !== null) {
			removeTempDirSync(tmpHome);
			tmpHome = null;
		}
	});

	/**
	 * Must-have 1 (frontmatter) + verification that a deeply-nested YAML
	 * block is entirely covered, not just the opener. The fixture keeps the
	 * frontmatter body long enough to force a multi-line `detectFrontmatterEnd`
	 * walk; the read lands inside the body of `## Sezione target` and the
	 * assertion checks the closing `---` line itself is inside the range
	 * (line 8, 1-indexed), so a buggy half-coverage (e.g. only the first
	 * key, or the closing fence only when it's adjacent to the heading) would
	 * surface.
	 */
	it("expands the YAML frontmatter into the enclosing section when the toggle is on", async () => {
		arrange({ readGuard: { markdown: { frontmatterAlwaysRead: true } } });
		const env = setupTestEnvironment("pi-lens-read-expansion-s06-fm-");
		try {
			const content = [
				"---",                                                          // 1
				"title: Test markdown doc",                                       // 2
				"author: tester",                                                // 3
				"date: 2026-09-10",                                              // 4
				"tags:",                                                         // 5
				"  - markdown",                                                  // 6
				"  - fixture",                                                   // 7
				"---",                                                           // 8
				"# Top heading",                                                 // 9
				"intro here",                                                    // 10
				"",                                                              // 11
				"## Sezione target",                                             // 12
				"Primo paragrafo della sezione target.",                         // 13
				"Continua il testo.",                                            // 14
				"",                                                              // 15
				"## Sezione successiva",                                         // 16
				"fine",                                                          // 17
				"",                                                              // 18
			].join("\n");
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(filePath, content);
			const tsClient = unusedClient("should not be called for markdown");

			// Read at line 13 (first line of "Primo paragrafo"), limit 2.
			const result = await tryExpandRead(filePath, 13, 2, 18, tsClient as any);
			expect(result).toBeDefined();
			expect(result!.enclosingSymbol.name).toBe("Sezione target");
			// With the toggle on, the frontmatter block (lines 1..8) is folded
			// into the enclosing range: startLine lands at the top of the file.
			expect(result!.enclosingSymbol.startLine).toBe(1);
			// The closing `---` (line 8) MUST be inside the expansion — this is
			// what makes an edit on the YAML fence covered by the read.
			expect(result!.enclosingSymbol.endLine).toBeGreaterThanOrEqual(8);
			// The section ends just before the next H2: line 15 is blank, line
			// 16 is "## Sezione successiva".
			expect(result!.enclosingSymbol.endLine).toBe(15);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * Must-have 1 (table above). The fixture places a markdown table whose
	 * trailing separator (`| - | - |`) sits IMMEDIATELY above the
	 * `## Sezione target` heading — the shape that `expandToTableAbove`
	 * actually detects. The assertion checks the heading-only fallback
	 * (`startLine === 9`, the heading line itself) is replaced by a value
	 * that includes the table rows above.
	 */
	it("expands the markdown table adjacent (above) to the section when the toggle is on", async () => {
		arrange({ readGuard: { markdown: { frontmatterAlwaysRead: true } } });
		const env = setupTestEnvironment("pi-lens-read-expansion-s06-tab-");
		try {
			const content = [
				"# Title",                  // 1
				"intro",                     // 2
				"",                          // 3
				"| H1 | H2 |",               // 4
				"| - | - |",                 // 5
				"| D1 | D2 |",               // 6
				"| D2 | D2 |",               // 7
				"| - | - |",                 // 8 (final separator — last table line, immediately above the section)
				"## Sezione target",         // 9
				"Primo paragrafo.",          // 10
				"Continua il testo.",        // 11
				"",                          // 12
				"## Sezione successiva",     // 13
				"fine",                      // 14
			].join("\n");
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(filePath, content);
			const tsClient = unusedClient("should not be called for markdown");

			// Read at line 10 (inside section), limit 2.
			const result = await tryExpandRead(filePath, 10, 2, 14, tsClient as any);
			expect(result).toBeDefined();
			expect(result!.enclosingSymbol.name).toBe("Sezione target");
			// Section start above is the heading (line 9) under the pre-S06
			// contract. With the adjacent table above recognised by
			// `expandToTableAbove`, the startLine must be < 9 (must include
			// at least the trailing separator, in practice the whole table).
			expect(result!.enclosingSymbol.startLine).toBeLessThan(9);
			// The end of the section is the blank line before the next H2.
			expect(result!.enclosingSymbol.endLine).toBe(12);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * Must-have 4 (toggle false). A file with both frontmatter AND adjacent
	 * table, configured with `frontmatterAlwaysRead: false`, must return the
	 * legacy heading-only range. Without this regression a future change that
	 * lifts the toggle gate would silently re-expand coverage for users who
	 * explicitly opted out.
	 */
	it("ignores frontmatter and adjacent tables when the toggle is off (regression)", async () => {
		arrange({ readGuard: { markdown: { frontmatterAlwaysRead: false } } });
		const env = setupTestEnvironment("pi-lens-read-expansion-s06-off-");
		try {
			const content = [
				"---",                                                          // 1
				"title: Test",                                                  // 2
				"---",                                                           // 3
				"# Top heading",                                                // 4
				"",                                                              // 5
				"## Sezione target",                                            // 6
				"contenuto",                                                     // 7
				"",                                                              // 8
				"## Sezione successiva",                                        // 9
				"fine",                                                          // 10
			].join("\n");
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(filePath, content);
			const tsClient = unusedClient("should not be called for markdown");

			const result = await tryExpandRead(filePath, 7, 2, 10, tsClient as any);
			expect(result).toBeDefined();
			// With toggle off: heading-only behaviour. startLine must be the
			// heading's line (line 6, 1-indexed = "## Sezione target"), NOT
			// the frontmatter start.
			expect(result!.enclosingSymbol.startLine).toBe(6);
			expect(result!.enclosingSymbol.endLine).toBe(8);
			expect(result!.enclosingSymbol.name).toBe("Sezione target");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * Must-have 3: the default-on toggle may only ADD coverage, never
	 * narrow it. A markdown file without frontmatter NOR adjacent tables
	 * must return the same range as the pre-fix heading-only path — even
	 * when the default-true toggle is in effect. No config file is written
	 * here, so the getter falls back to its default `true`, exercising that
	 * branch of the contract.
	 */
	it("preserves the heading-only behaviour when there is no frontmatter nor adjacent table (default-on)", async () => {
		arrange(null);
		const env = setupTestEnvironment("pi-lens-read-expansion-s06-must3-");
		try {
			const content = [
				"# Title",                  // 1
				"",                          // 2
				"## Section A",              // 3
				"line of body",              // 4
				"",                          // 5
				"## Section B",              // 6
				"line of body",              // 7
			].join("\n");
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(filePath, content);
			const tsClient = unusedClient("should not be called for markdown");

			const result = await tryExpandRead(filePath, 4, 1, 7, tsClient as any);
			expect(result).toBeDefined();
			// Section starts at the H2 (line 3, 1-indexed) and ends at the
			// blank line (line 5, 1-indexed) before the next H2 — exactly the
			// pre-S06 heading-only behaviour.
			expect(result!.enclosingSymbol.startLine).toBe(3);
			expect(result!.enclosingSymbol.endLine).toBe(5);
			expect(result!.enclosingSymbol.name).toBe("Section A");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * Boundary check on `detectFrontmatterEnd`: the closing `---` line MUST
	 * itself be inside the expansion (line 5, 1-indexed). A bug where the
	 * implementation stops one row short of the closing fence (e.g. because
	 * the line is read as part of the section content) would leave the
	 * user editing a YAML key past the fence still uncovered. The assertion
	 * `endLine >= 5` is the red-first discriminator for that class.
	 */
	it("frontmatter expansion covers the entire YAML block including the closing fence", async () => {
		arrange({ readGuard: { markdown: { frontmatterAlwaysRead: true } } });
		const env = setupTestEnvironment("pi-lens-read-expansion-s06-fmbound-");
		try {
			const content = [
				"---",                                                          // 1
				"title: T",                                                     // 2
				"author: a",                                                    // 3
				"tags: [x, y]",                                                 // 4
				"---",                                                           // 5
				"",                                                              // 6
				"# Top heading",                                                // 7
				"",                                                              // 8
				"## Sezione target",                                            // 9
				"Primo paragrafo.",                                             // 10
				"Altro paragrafo.",                                             // 11
				"",                                                              // 12
				"## Sezione successiva",                                        // 13
				"fine",                                                          // 14
			].join("\n");
			const filePath = path.join(env.tmpDir, "file.md");
			fs.writeFileSync(filePath, content);
			const tsClient = unusedClient("should not be called for markdown");

			const result = await tryExpandRead(filePath, 10, 1, 14, tsClient as any);
			expect(result).toBeDefined();
			expect(result!.enclosingSymbol.startLine).toBe(1);
			// Closing `---` (line 5) MUST be covered by the expansion.
			expect(result!.enclosingSymbol.endLine).toBeGreaterThanOrEqual(5);
			// The expansion also stops short of the next H2 (line 13).
			expect(result!.enclosingSymbol.endLine).toBe(12);
		} finally {
			env.cleanup();
		}
	});
});
