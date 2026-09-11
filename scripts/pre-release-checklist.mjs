#!/usr/bin/env node
/**
 * Pre-release pre-flight: attesti la riproducibilità dei check automatizzabili
 * del fork @gsd/pi-lens (slice S09, milestone M001).
 *
 * SCOPE — Questo script NON sostituisce il gate umano documentato in
 * `docs/release-gate.md` (run-through operativo del maintainer su una
 * sessione `gsd` reale, ispezione di 15 tool registrati, 9 bus events,
 * read-guard markdown, degradazione `registerEntryRenderer`). Riduce il
 * rischio di "ho taggato una release e due giorni dopo `npm test` era
 * rosso" producendo una pre-flight riproducibile dei check statici e dei
 * tre subprocess (lint, test, install-shape). Lo smoke `gsd` reale resta
 * responsabilità del maintainer via T02.
 *
 * EXIT SEMANTICS — 0 quando tutti i check richiesti passano, 1 quando
 * almeno uno fallisce (subprocess exit≠0, timeout, assertion statica
 * mancata, rottura strutturale oltre soglia). 2 quando l'argomento CLI è
 * invalido. L'ultima riga dello stdout è `READY FOR HUMAN GATE` (tutti
 * OK) o `BLOCKED: <elenco nomi>` (almeno uno FAIL), parsabile da CI.
 *
 * USAGE
 *   node scripts/pre-release-checklist.mjs               # all checks
 *   node scripts/pre-release-checklist.mjs --check-only <name>   # scoped
 *   node scripts/pre-release-checklist.mjs --help        # usage
 *
 * CHECKS (6)
 *   lint                `npm run lint` (timeout 60s)
 *   test                `npm test` con PI_LENS_TEST_NO_LOCK=1 e
 *                        PI_LENS_TEST_TIMEOUT_SCALE=3 (timeout 600s)
 *   install-shape       `node scripts/check-prod-install-shape.mjs`
 *                        (timeout 30s)
 *   tool-registrations  parser statico su index.ts: ricava i blocchi
 *                        `alwaysActiveTools` e `lazyTools` via regex
 *                        (bracket-balanced, refrattario a refactor) più
 *                        il loader top-level `const X = createYTool(
 *                        ...)`, dedupe via Set, conta `create*Tool(`.
 *                        Atteso 15 (8 + 1 loader + 6). Fail se <10 o
 *                        >25 (rottura strutturale). Warn ma pass se
 *                        count ∈ [10,25] e ≠15.
 *   flag-registrations  conta `name: "<flag>"` in
 *                        clients/lens-flag-registry.ts. Pass se count>0;
 *                        fail con detail="no flag entries" se count=0.
 *   bus-channels        verifica 8 literal esatti nei 5 publisher modules
 *                        + 1 template-literal `pilens:rpc:${...}:response`
 *                        in rpcResponseChannel. Pass se <2 missing.
 *
 * TIME BUDGET — ogni subprocess ha un timeout proprio (vedi tabella
 * sopra). I check statici hanno budget 5s. Un timeout riporta FAIL
 * con dettaglio `timed-out`.
 *
 * Niente nuove dipendenze: solo node builtins (fs, child_process, path, url).
 * Per il run-through operativo vedi `docs/release-gate.md`.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// --- Paths ---

const scriptRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repoRoot = scriptRoot;

// --- CLI parsing ---

const argv = process.argv.slice(2);

function printUsage() {
	const lines = [
		"Usage:",
		"  node scripts/pre-release-checklist.mjs                 # run all checks",
		"  node scripts/pre-release-checklist.mjs --check-only <name>   # one check",
		"  node scripts/pre-release-checklist.mjs --help                # this help",
		"",
		"Available checks:",
		"  lint, test, install-shape, tool-registrations, flag-registrations, bus-channels",
		"",
		"Exit codes: 0 all checks passed, 1 at least one check failed.",
		"For the human release gate run-through see docs/release-gate.md.",
	];
	for (const line of lines) process.stderr.write(`${line}\n`);
}

if (argv.includes("--help") || argv.includes("-h")) {
	printUsage();
	process.exit(0);
}

const onlyIdx = argv.indexOf("--check-only");
const onlyMode = onlyIdx !== -1;
const onlyName = onlyMode ? argv[onlyIdx + 1] : null;
if (onlyMode && !onlyName) {
	process.stderr.write("[pre-release-checklist] --check-only requires a name\n");
	printUsage();
	process.exit(2);
}

// --- Check catalog ---

const ALL_CHECKS = ["lint", "test", "install-shape", "tool-registrations", "flag-registrations", "bus-channels"];

if (onlyMode && !ALL_CHECKS.includes(onlyName)) {
	process.stderr.write(
		`[pre-release-checklist] unknown check "${onlyName}". Known: ${ALL_CHECKS.join(", ")}\n`,
	);
	process.exit(2);
}

const checksToRun = onlyMode ? [onlyName] : ALL_CHECKS;

// --- Output helpers ---

const results = []; // { name, ok, durationMs, detail }

function record(name, ok, durationMs, detail) {
	results.push({ name, ok, durationMs, detail });
	const tag = ok ? "OK" : "FAIL";
	const safeDetail = String(detail ?? "").replace(/\n/g, " ").slice(0, 200);
	process.stderr.write(`[pre-release-checklist] ${tag} ${name} ${durationMs}ms ${safeDetail}\n`);
}

// --- Subprocess runner ---

function runSubprocess({ cmd, args, timeoutMs, env, cwd }) {
	const start = Date.now();
	const mergedEnv = { ...process.env, ...env };
	const res = spawnSync(cmd, args, {
		cwd: cwd ?? repoRoot,
		timeout: timeoutMs,
		env: mergedEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const durationMs = Date.now() - start;

	if (res.error) {
		if (res.error.code === "ETIMEDOUT") {
			return { ok: false, durationMs, detail: `timed-out (${timeoutMs}ms)` };
		}
		return { ok: false, durationMs, detail: `spawn-error: ${res.error.message}` };
	}
	if (res.status === 0) {
		const tail = (res.stdout || "").trim().split("\n").pop() || "exit 0";
		return { ok: true, durationMs, detail: tail.slice(0, 160) };
	}
	const tail = ((res.stderr || res.stdout || "").trim().split("\n").pop()) || `exit ${res.status}`;
	return { ok: false, durationMs, detail: `exit-${res.status} ${tail.slice(0, 160)}` };
}

// --- Bracket-balanced extraction (string- and comment-aware) ---

// Walks forward from `openIdx + 1` looking for the matching close char.
// Tracks depth for ()/[]/{}, skipping string literals (" ' `) and both
// comment flavors. Returns the index just past the matching close, or -1
// if the close is not found.
function findMatchingClose(text, openIdx, _openChar, _closeChar) {
	const otherOpen = new Set(["(", "[", "{"]);
	const otherClose = new Set([")", "]", "}"]);
	let depth = 1;
	let i = openIdx + 1;
	while (i < text.length) {
		const c = text[i];
		// String literals
		if (c === '"' || c === "'" || c === "`") {
			const q = c;
			i++;
			while (i < text.length) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === q) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}
		// Line comments
		if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			continue;
		}
		// Block comments
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length) {
				if (text[i] === "*" && text[i + 1] === "/") {
					i += 2;
					break;
				}
				i++;
			}
			continue;
		}
		if (otherOpen.has(c)) depth++;
		else if (otherClose.has(c)) depth--;
		i++;
		if (depth === 0) return i;
	}
	return -1;
}

// Extract the body text of a top-level array literal `const NAME = [ ... ]`.
// Returns the substring spanning the full declaration (including `const NAME = [`)
// or null if the array is not found.
function extractArrayBlock(text, arrayName) {
	const escaped = arrayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Allow leading indentation (1 level of tab / spaces) between the newline
	// boundary and the declaration keyword, matching how index.ts nests the
	// arrays inside its module body.
	const re = new RegExp(
		`(?:^|[\\t ]*\\n[\\t ]*)(?:const|let|var)\\s+${escaped}\\s*=\\s*\\[`,
	);
	const m = re.exec(text);
	if (!m) return null;
	const openBracketIdx = m.index + m[0].length - 1; // index of `[`
	const closeIdx = findMatchingClose(text, openBracketIdx, "[", "]");
	if (closeIdx < 0) return null;
	return text.slice(m.index, closeIdx);
}

// Extract top-level single-tool const declarations:
// `const X = createYTool( ... );` where the right side is a single create call.
// Indent must be <4 (top-level only, never inside an array block).
function extractTopLevelToolConsts(text) {
	const singleRe =
		/(?:^|\n)([ \t]{0,3})(?:const|let|var)\s+\w+\s*=\s*create([A-Z][A-Za-z]+)Tool\s*\(/g;
	const chunks = [];
	let m;
	while ((m = singleRe.exec(text)) !== null) {
		const openParenIdx = m.index + m[0].length - 1; // index of `(`
		const closeIdx = findMatchingClose(text, openParenIdx, "(", ")");
		if (closeIdx < 0) continue;
		chunks.push(text.slice(m.index, closeIdx));
	}
	return chunks;
}

// --- Check implementations ---

function checkLint() {
	return runSubprocess({
		cmd: "npm",
		args: ["run", "lint"],
		timeoutMs: 60_000,
	});
}

function checkTest() {
	return runSubprocess({
		cmd: "npm",
		args: ["test"],
		timeoutMs: 600_000,
		env: {
			PI_LENS_TEST_NO_LOCK: "1",
			PI_LENS_TEST_TIMEOUT_SCALE: "3",
		},
	});
}

function checkInstallShape() {
	return runSubprocess({
		cmd: process.execPath,
		args: [path.join(repoRoot, "scripts", "check-prod-install-shape.mjs")],
		timeoutMs: 30_000,
	});
}

function checkToolRegistrations() {
	const start = Date.now();
	const indexPath = path.join(repoRoot, "index.ts");
	if (!existsSync(indexPath)) {
		return {
			ok: false,
			durationMs: Date.now() - start,
			detail: "missing index.ts",
		};
	}
	const text = readFileSync(indexPath, "utf8");

	// Scope detection by regex (NOT hardcoded line ranges):
	// - alwaysActiveTools = [ ... ]
	// - lazyTools = [ ... ]
	// - top-level `const X = createYTool( ... );` (catches the loader)
	const chunks = [];
	for (const arrayName of ["alwaysActiveTools", "lazyTools"]) {
		const block = extractArrayBlock(text, arrayName);
		if (!block) {
			return {
				ok: false,
				durationMs: Date.now() - start,
				detail: `missing array block: ${arrayName}`,
			};
		}
		chunks.push(block);
	}
	chunks.push(...extractTopLevelToolConsts(text));

	const createRe = /\bcreate([A-Z][A-Za-z]+)Tool\s*\(/g;
	const toolNames = new Set();
	for (const chunk of chunks) {
		for (const m of chunk.matchAll(createRe)) {
			toolNames.add(`create${m[1]}Tool`);
		}
	}

	const durationMs = Date.now() - start;
	const found = toolNames.size;
	const expected = 15;

	// Structural break: count is far from the expected band.
	if (found < 10 || found > 25) {
		return {
			ok: false,
			durationMs,
			detail: `count=${found} expected~${expected} structural-break names=${[...toolNames].sort().join(",")}`,
		};
	}

	// Soft mismatch: in the warning band but not the canonical count.
	if (found !== expected) {
		return {
			ok: true,
			durationMs,
			detail: `count=${found} expected=${expected} WARN`,
		};
	}

	return {
		ok: true,
		durationMs,
		detail: `count=${found} (8 always-active + 1 loader + 6 lazy)`,
	};
}

function checkFlagRegistrations() {
	const start = Date.now();
	const flagPath = path.join(repoRoot, "clients", "lens-flag-registry.ts");
	if (!existsSync(flagPath)) {
		return {
			ok: false,
			durationMs: Date.now() - start,
			detail: "missing clients/lens-flag-registry.ts",
		};
	}
	const text = readFileSync(flagPath, "utf8");
	const matches = text.match(/^\s+name:\s+"[^"]+"/gm) ?? [];
	const durationMs = Date.now() - start;
	const found = matches.length;
	if (found === 0) {
		return {
			ok: false,
			durationMs,
			detail: "no flag entries",
		};
	}
	return {
		ok: true,
		durationMs,
		detail: `count=${found}`,
	};
}

function checkBusChannels() {
	const start = Date.now();
	const checks = [
		{ file: "clients/bus-publish.ts", literal: "pilens:files:touched" },
		{ file: "clients/diagnostics-publish.ts", literal: "pilens:diagnostics" },
		{ file: "clients/disposition-publish.ts", literal: "pilens:diagnostic:disposition" },
		{ file: "clients/format-events-publish.ts", literal: "pilens:format:queued" },
		{ file: "clients/format-events-publish.ts", literal: "pilens:format:start" },
		{ file: "clients/format-events-publish.ts", literal: "pilens:autofix:start" },
		{ file: "clients/rpc-publish.ts", literal: "pilens:rpc:diagnostics" },
		{ file: "clients/rpc-publish.ts", literal: "pilens:rpc:files-touched" },
	];
	const missing = [];
	for (const { file, literal } of checks) {
		const abs = path.join(repoRoot, file);
		if (!existsSync(abs)) {
			missing.push(`${file} (file missing)`);
			continue;
		}
		const text = readFileSync(abs, "utf8");
		if (!text.includes(literal)) {
			missing.push(`${file}: ${literal}`);
		}
	}
	// Response channel: built via `pilens:rpc:${token}:response` template literal
	// inside rpcResponseChannel (rpc-publish.ts). Verify the template is present
	// so a future refactor that drops the helper or breaks the shape trips the
	// gate.
	const rpcPath = path.join(repoRoot, "clients", "rpc-publish.ts");
	if (existsSync(rpcPath)) {
		const rpcText = readFileSync(rpcPath, "utf8");
		const responsePattern = /`pilens:rpc:\${[^}]+}:response`/;
		if (!responsePattern.test(rpcText)) {
			missing.push("rpc-publish.ts: rpcResponseChannel template literal");
		}
	} else {
		missing.push("rpc-publish.ts (file missing)");
	}
	const durationMs = Date.now() - start;
	const total = checks.length + 1;
	const found = total - missing.length;
	// Pass when fewer than 2 missing (the bus surface is largely intact).
	// Fail on structural break (2+ missing).
	if (missing.length >= 2) {
		return {
			ok: false,
			durationMs,
			detail: `found=${found}/${total} missing=${missing.length} missing-list=${missing.join(" | ")}`,
		};
	}
	if (missing.length === 1) {
		return {
			ok: true,
			durationMs,
			detail: `found=${found}/${total} (1 missing: ${missing[0]}) WARN`,
		};
	}
	return {
		ok: true,
		durationMs,
		detail: `found=${found}/${total} (6 push + 3 RPC incl. response template)`,
	};
}

const CHECKS = {
	lint: checkLint,
	test: checkTest,
	"install-shape": checkInstallShape,
	"tool-registrations": checkToolRegistrations,
	"flag-registrations": checkFlagRegistrations,
	"bus-channels": checkBusChannels,
};

// --- Run ---

for (const name of checksToRun) {
	const fn = CHECKS[name];
	const result = fn();
	record(name, result.ok, result.durationMs, result.detail);
}

// --- Final summary ---

const failed = results.filter((r) => !r.ok).map((r) => r.name);
if (failed.length === 0) {
	process.stdout.write("READY FOR HUMAN GATE\n");
	process.exit(0);
}
process.stdout.write(`BLOCKED: ${failed.join(", ")}\n`);
process.exit(1);
