import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/module-instance-scan.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const EVENT_DIAGNOSTICS = "pilens:rpc:diagnostics";
const EVENT_FILES_TOUCHED = "pilens:rpc:files-touched";
const RESPONSE_PREFIX = "pilens:rpc:";
const RESPONSE_SUFFIX = ":response";

type BusSurfaceEntry = {
	file: string;
	why: string;
};

// R009 / S07 — request/response surface on the shared `pi.events` bus. A
// single module (`clients/rpc-publish.ts`) owns BOTH the request subscriptions
// and the response emissions today: the canonical `rpcResponseChannel(token)`
// helper constructs the per-token response channel, and the per-request event
// constants are exported only for callers wiring THEIR OWN subscription. No
// external module emits `pilens:rpc:<token>:response` or subscribes to the
// request events — this census stays empty unless a second module joins.
const PUBLISHERS: BusSurfaceEntry[] = [
	{
		file: "clients/rpc-publish.ts",
		why: "publishes pilens:rpc:<token>:response carrying PilensDiagnosticsPayload verbatim per R009",
	},
];

const SUBSCRIBERS: BusSurfaceEntry[] = [
	{
		file: "clients/rpc-publish.ts",
		why: "subscribes to pilens:rpc:diagnostics and pilens:rpc:files-touched on pi.events; reads widgetState + recentTouches",
	},
];

function sourceFiles(): string[] {
	const roots = ["clients", "tools", "mcp", "scripts"];
	const files = roots.flatMap((root) =>
		listSourceFiles(path.join(repoRoot, root), {
			extensions: [".ts"],
			skipDeclarations: false,
		}),
	);
	files.push(path.join(repoRoot, "index.ts"));
	const result = [...new Set(files)]
		.map((file) => relativePosix(repoRoot, file))
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	assertNonEmptyScan("pilens:rpc:* bus source scan", result.length);
	return result;
}

function read(file: string): string {
	return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

/**
 * Publisher detection — a file emits on the per-token response channel.
 * Three recognized patterns (strings are KEPT so template-literal
 * interpolations stay visible to the regex):
 *
 *   1. `events.emit(rpcResponseChannel(token), wrapper)` — the legacy call
 *      shape, still accepted so a future consumer of the channel that
 *      bypasses the live-emitter resolver stays discoverable.
 *   2. `resolution.emit(rpcResponseChannel(token), wrapper)` — the canonical
 *      shape inside `clients/rpc-publish.ts` since S07/T02: the response
 *      goes through `resolveLiveBusEmitter(...)` and emits via
 *      `resolution.emit(...)`, where `resolution` is the value the resolver
 *      already returned (probed for a stale ctx). The
 *      `bus-producer-coverage.test.ts` "no bare .emit(" detector restricts
 *      producer call sites to this exact caller.
 *   3. `events.emit(`pilens:rpc:${token}:response`, ...)` — any literal or
 *      template literal matching `pilens:rpc:` + any token content +
 *      `:response`.
 *
 * Comments are blanked by `stripSource` regardless of string policy, so a
 * commented-out emit never counts.
 */
function busPublisherFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files.filter((file) => {
		const source = stripSource(sources.get(file) ?? "", { strings: "keep" });
		const helperEmit =
			/\b(?:events?|resolution)\s*\.emit\s*\(\s*rpcResponseChannel\s*\(/.test(
				source,
			);
		const literalEmit = new RegExp(
			`\\bevents?\\s*\\.emit\\s*\\(\\s*["'\`]${RESPONSE_PREFIX}[^"'\`]*${RESPONSE_SUFFIX}["'\`]`,
		).test(source);
		return helperEmit || literalEmit;
	});
}

/**
 * Subscriber detection — a file subscribes to one of the two RPC request
 * channels. Recognized patterns (strings kept so the literal event name stays
 * visible to the regex):
 *
 *   1. The exported event constants (`BUS_RPC_REQUEST_DIAGNOSTICS_EVENT` /
 *      `BUS_RPC_REQUEST_FILES_TOUCHED_EVENT`), with optional `as` rename, from
 *      `clients/rpc-publish.js`.
 *   2. A local `const`/`let`/`var` bound to the literal
 *      `"pilens:rpc:diagnostics"` or `"pilens:rpc:files-touched"`.
 *   3. The literal event string inside a `.on(` call.
 *
 * A bare `events.on(pilens:rpc:diagnostics, ...)` (no quotes, identifier-only)
 * does NOT count: that is not legal JS, and accepting it would silently
 * launder any typo'd identifier. The literal must be a string.
 */
function busSubscriberFiles(
	files: string[],
	sources: Map<string, string>,
): string[] {
	return files.filter((file) => {
		const source = stripSource(sources.get(file) ?? "", { strings: "keep" });
		const bindings = new Set<string>();
		const diagnosticLit =
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']pilens:rpc:diagnostics["']/g;
		const filesTouchedLit =
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']pilens:rpc:files-touched["']/g;
		let match: RegExpExecArray | null;
		while ((match = diagnosticLit.exec(source))) bindings.add(match[1]);
		while ((match = filesTouchedLit.exec(source))) bindings.add(match[1]);
		const busImport =
			/import\s*\{([^}]*)\}\s*from\s*["'][^"']*rpc-publish(?:\.js)?["']/g;
		while ((match = busImport.exec(source))) {
			for (const specifier of match[1].split(",")) {
				const eventImport =
					/^\s*BUS_RPC_REQUEST_(?:DIAGNOSTICS|FILES_TOUCHED)_EVENT\b(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
						specifier,
					);
				if (eventImport) {
					bindings.add(eventImport[1] ?? "BUS_RPC_REQUEST_DIAGNOSTICS_EVENT");
				}
			}
		}
		const eventArgument = `(?:["']${EVENT_DIAGNOSTICS}["']|["']${EVENT_FILES_TOUCHED}["']|${
			[...bindings].map((binding) => escapeRegExp(binding)).join("|") || "(?!)"
		})`;
		return new RegExp(`\\.on\\s*\\(\\s*${eventArgument}(?=\\s*[,)])`).test(
			source,
		);
	});
}

describe("pilens:rpc:* bus surface (R009 / S07)", () => {
	it("keeps the request event constants and response channel helper in conformance", () => {
		const docs = read("clients/rpc-publish.ts");
		expect(docs, "exports the diagnostics request event name").toContain(
			`"${EVENT_DIAGNOSTICS}"`,
		);
		expect(docs, "exports the files-touched request event name").toContain(
			`"${EVENT_FILES_TOUCHED}"`,
		);
		// `rpcResponseChannel(token)` is the one place that constructs the
		// per-token response channel — it MUST concatenate
		// `RESPONSE_PREFIX` + token + `RESPONSE_SUFFIX`. The regex pins the
		// shape so a future refactor that switches to a non-template
		// construction (`"pilens:rpc:" + token + ":response"`, or a
		// precomputed table) trips this guard and forces the conformance
		// tests to be updated alongside.
		const helperBody =
			/function\s+rpcResponseChannel\s*\(\s*token\s*:\s*string\s*\)\s*:\s*string\s*\{[^}]*pilens:rpc:\$\{token\}:response[^}]*\}/.test(
				docs,
			);
		expect(
			helperBody,
			"rpcResponseChannel must concatenate prefix+token+suffix",
		).toBe(true);
	});

	it("keeps the publisher list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const eventFiles = files.filter(
			(file) =>
				read(file).includes(EVENT_DIAGNOSTICS) ||
				read(file).includes(EVENT_FILES_TOUCHED) ||
				read(file).includes(`${RESPONSE_PREFIX}${RESPONSE_SUFFIX}`),
		);
		expect(eventFiles).toContain("clients/rpc-publish.ts");

		const actual = busPublisherFiles(files, sources).sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		expect(actual, "new publisher: update PUBLISHERS and AGENTS.md").toEqual(
			PUBLISHERS.map((entry) => entry.file).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		);
	});

	it("keeps the subscriber list in conformance", () => {
		const files = sourceFiles();
		const sources = new Map(files.map((file) => [file, read(file)]));
		const actual = busSubscriberFiles(files, sources).sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		expect(actual, "new subscriber: update SUBSCRIBERS and AGENTS.md").toEqual(
			SUBSCRIBERS.map((entry) => entry.file).sort((a, b) =>
				a < b ? -1 : a > b ? 1 : 0,
			),
		);
	});

	it("ignores comments and recognizes template-literal, imported, and literal publishers and subscribers", () => {
		const files = [
			"comment.ts",
			"template-pub.ts",
			"imported-sub.ts",
			"literal-sub.ts",
		];
		const sources = new Map<string, string>([
			// The whole line is a `//` comment — neither detector fires.
			[
				"comment.ts",
				"// events.emit(rpcResponseChannel(token), wrapper); bus.on(EVENT, handler);",
			],
			// External publisher using a template-literal response channel.
			[
				"template-pub.ts",
				"events.emit(`pilens:rpc:${token}:response`, wrapper);",
			],
			// External subscriber using the imported event constant (renamed).
			[
				"imported-sub.ts",
				'import { BUS_RPC_REQUEST_DIAGNOSTICS_EVENT as DIAGS } from "./rpc-publish.js"; bus.on(DIAGS, handler);',
			],
			// External subscriber using the literal event string.
			["literal-sub.ts", 'bus.on("pilens:rpc:diagnostics", handler);'],
		]);
		expect(busPublisherFiles(files, sources)).toEqual(["template-pub.ts"]);
		expect(busSubscriberFiles(files, sources)).toEqual([
			"imported-sub.ts",
			"literal-sub.ts",
		]);
	});

	it("requires every declaration to explain why the bus applies", () => {
		const docs = read("AGENTS.md");
		for (const entry of [...PUBLISHERS, ...SUBSCRIBERS]) {
			expect(entry.why.length, `${entry.file} needs a reason`).toBeGreaterThan(
				20,
			);
			expect(docs, `${entry.file} is missing from AGENTS.md`).toContain(
				entry.file,
			);
		}
	});
});
