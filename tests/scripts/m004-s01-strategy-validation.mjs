#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

function fail(msg) { console.error("FAIL:", msg); process.exit(1); }
function mustExist(p, label) { if (!existsSync(p)) fail(label + " missing: " + p); }
function mustNotExist(p, label) { if (existsSync(p)) fail(label + " should not exist: " + p); }

// 1. Workflow disattivati (7): trigger = workflow_dispatch only.
const disabledWorkflows = [
  "ci-infra-kill-rerun.yml",
  "greetings.yml",
  "labels.yml",
  "merge-train-lane.yml",
  "merge-train-warden.yml",
  "stale-open-issues.yml",
  "stale.yml",
];
for (const wf of disabledWorkflows) {
  mustExist(".github/workflows/" + wf, "disabled workflow");
  const content = readFileSync(".github/workflows/" + wf, "utf8");
  if (!/workflow_dispatch/.test(content)) fail("disabled workflow missing workflow_dispatch: " + wf);
  if (/^on:\s*\n\s+(push|pull_request|schedule|workflow_run):/m.test(content)) {
    fail("disabled workflow has automatic trigger: " + wf);
  }
}

// 2. release.yml rimosso.
mustNotExist(".github/workflows/release.yml", "release.yml");

// 3. publish.yml (fork-only) presente.
mustExist(".github/workflows/publish.yml", "publish.yml");
const publishContent = readFileSync(".github/workflows/publish.yml", "utf8");
if (!/OIDC|id-token:\s*write/.test(publishContent)) fail("publish.yml missing OIDC/id-token:write");

// 4. package.json fork wins.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.name !== "@efrembaraldo/gsd-pi-lens") fail("pkg.name wrong: " + pkg.name);
if (!pkg.gsd || pkg.gsd.extension !== true) fail("gsd.extension != true");
const peerDeps = pkg.peerDependencies ?? {};
if (!peerDeps["@opengsd/gsd-pi"]) fail("peer @opengsd/gsd-pi missing");
// Local adaptation: @gsd/pi-coding-agent and @gsd/pi-tui are host-provided
// packages, declared as peerDependencies (not dependencies/devDependencies)
// in the fork's package.json — the @gsd/* scope check must include them.
const allDeps = JSON.stringify(pkg.dependencies ?? {})
	+ JSON.stringify(pkg.devDependencies ?? {})
	+ JSON.stringify(pkg.peerDependencies ?? {});
if (!/"@gsd\/pi-coding-agent"/.test(allDeps)) fail("dep @gsd/pi-coding-agent missing");
if (!/"@gsd\/pi-tui"/.test(allDeps)) fail("dep @gsd/pi-tui missing");

// 5. index.ts RPC bus + nuovi tool.
const idx = readFileSync("index.ts", "utf8");
const rpcCount = (idx.match(/wireRpcBusSubscriber|readBusRpcDiagnosticsState/g) ?? []).length;
if (rpcCount < 4) fail("RPC bus count " + rpcCount + " < 4");
const toolsCount = (idx.match(/createModuleReportTool|createReadEnclosingTool|createReadSymbolTool/g) ?? []).length;
if (toolsCount < 4) fail("new tool count " + toolsCount + " < 4");

// 6. clients/test-runner-delivery.ts combinazione.
const trd = readFileSync("clients/test-runner-delivery.ts", "utf8");
if (!trd.includes("TEST_RUNNER_ENTRY_TYPE")) fail("TEST_RUNNER_ENTRY_TYPE missing");
if (!trd.includes("logDeliveredVerdicts")) fail("logDeliveredVerdicts missing");

// 7. AGENTS.md combinazione.
const ag = readFileSync("AGENTS.md", "utf8");
if (!ag.includes("How to use this file")) fail("AGENTS upstream header missing");
// Local adaptation: the fork's AGENTS.md uses camelCase identifiers and event
// channel names (wireRpcBusSubscriber, pilens:rpc:*, rpc-bus-conformance,
// files-touched-bus) rather than the prose phrase "RPC bus". The upstream
// v4.3.0 AGENTS.md has none of these; presence of any of them confirms the
// fork-only RPC bus / files-touched bus documentation survived the merge.
if (!/pilens:rpc|wireRpcBusSubscriber|rpc-bus-conformance|files-touched-bus|pre-release/.test(ag)) fail("AGENTS fork-only section missing");

// 8. CHANGELOG.md combinazione.
const cl = readFileSync("CHANGELOG.md", "utf8");
if (!cl.includes("[4.3.0]")) fail("CHANGELOG [4.3.0] missing");
if (!cl.includes("Modifiche strutturali")) fail("CHANGELOG fork section missing");

// 9. docs/features.md adotta upstream.
const ft = readFileSync("docs/features.md", "utf8");
if (!/46 LSP|Typst/.test(ft)) fail("docs/features.md missing upstream Typst/46 LSP");

// 10. tests/config/knip-entry-coverage.test.ts adotta upstream.
mustExist("tests/config/knip-entry-coverage.test.ts", "knip-entry-coverage");
const kn = readFileSync("tests/config/knip-entry-coverage.test.ts", "utf8");
if (!/#3082|#3179|#3104|tests-tree-write-guard/.test(kn)) fail("knip-entry-coverage upstream refs missing");

// 11. tests/real-harness/diagnostic-provenance.test.ts adotta upstream.
mustExist("tests/real-harness/diagnostic-provenance.test.ts", "diagnostic-provenance");

// 12. tests/support/flake-shape-baseline.json aggiornato.
mustExist("tests/support/flake-shape-baseline.json", "flake-shape-baseline");

// 13. Feature fork-only presence.
const forkOnlyFiles = [
  "clients/rpc-publish.ts",
  "clients/live-bus-emitter.ts",
  "scripts/pre-release-checklist.mjs",
  "tests/scripts/fork-publish-roundtrip.test.ts",
  "tests/clients/runtime-session-error-debt-baseline.test.ts",
  "tests/mcp/fresh-warmup-honesty.smoke.test.ts",
  "tests/config/rpc-bus-conformance.test.ts",
  "tests/clients/rpc-publish.test.ts",
];
for (const f of forkOnlyFiles) mustExist(f, "fork-only file");

console.log("OK: M004/S01 strategy validation passed.");