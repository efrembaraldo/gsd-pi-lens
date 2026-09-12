# Pre-release gate

This document is the human checklist a maintainer runs **before** cutting a tag or opening a release branch for the `@gsd/pi-lens` fork. The gate proves behavioral compatibility with a real `gsd` session that no automated test can prove: tool registration, bus event surface, read-guard markdown coverage, and graceful degradation when the host lacks a feature surface.

Use this checklist together with `README.md` and `CHANGELOG.md` for fork context, and `docs/features.md` for the extended shape of every fix cited in the S03-S08 recap sections.

Run `scripts/pre-release-checklist.mjs` first to confirm the reproducible checks (lint, test, install shape, tool count, flag count, bus channel literals). Then run the run-through at the bottom of this document in a real `gsd` session. The script and the checklist are complementary: the script catches static breakage; this document catches runtime behavior.

## Tool count discrepancy

The R011 specification calls for 12 registered tools. The current fork registers **15 tool** instances: 8 always-active, 1 loader, 6 situational. The loader is `pi_lens_activate_tools`, the dynamic activation surface added in `#1453`. The 6 situational tools register inactive on hosts that support pi's dynamic tooling and stay statically active elsewhere.

The three registration arrays live in `index.ts`:

- `alwaysActiveTools` at `index.ts:1732` (8 entries).
- `lazyTools` at `index.ts:1810` (6 entries).
- `LAZY_TOOL_CATALOG` at `index.ts:1829` (6 entries, advertised to `pi_lens_activate_tools`).

The tool count comes from `git ls-files index.ts | xargs grep -cE "createLens|CreateLsp|createSymbol|createAstGrep|createRead|createActivateTools"`, never from a grep that crosses into `.gitignore`d paths.

## Family 1 - Tool registrations

The maintainer opens `/lens-tools` (pi command) or runs `lens_diagnostics --help` inside a session and verifies each row is present.

| # | Tool name | Verify in |
|---|-----------|-----------|
| 1 | `lens_diagnostics` | `/lens-tools` |
| 2 | `lsp_diagnostics` | `/lens-tools` |
| 3 | `symbol_search` | `/lens-tools` |
| 4 | `effective_config` | `/lens-tools` |
| 5 | `project_report` | `/lens-tools` |
| 6 | `module_report` | `/lens-tools` |
| 7 | `read_symbol` | `/lens-tools` |
| 8 | `read_enclosing` | `/lens-tools` |
| 9 | `pi_lens_activate_tools` (loader) | `/lens-tools` |
| 10 | `ast_grep_search` (lazy) | activate then `/lens-tools` |
| 11 | `ast_grep_replace` (lazy) | activate then `/lens-tools` |
| 12 | `ast_grep_outline` (lazy) | activate then `/lens-tools` |
| 13 | `ast_grep_dump` (lazy) | activate then `/lens-tools` |
| 14 | `lsp_navigation` (lazy) | activate then `/lens-tools` |
| 15 | `lens_diagnostic_mark` (lazy) | activate then `/lens-tools` |

Rows 10-15 appear in `/lens-tools` only after the model calls `pi_lens_activate_tools` with the matching name. The loader surfaces `LAZY_TOOL_CATALOG` (one entry per lazy tool).

## Family 2 - Bus events

The maintainer attaches a console listener to `pi.events` and triggers the action that fires each channel. The channel name strings are literal exports; do not paraphrase.

### Push channels (6)

| Channel | Source file | Export |
|---------|-------------|--------|
| `pilens:files:touched` | `clients/bus-publish.ts:31` | `BUS_FILES_TOUCHED_EVENT` |
| `pilens:diagnostics` | `clients/diagnostics-publish.ts:73` | `BUS_DIAGNOSTICS_EVENT` |
| `pilens:diagnostic:disposition` | `clients/disposition-publish.ts:35` | `BUS_DISPOSITION_EVENT` |
| `pilens:format:queued` | `clients/format-events-publish.ts:88` | `BUS_FORMAT_QUEUED_EVENT` |
| `pilens:format:start` | `clients/format-events-publish.ts:91` | `BUS_FORMAT_START_EVENT` |
| `pilens:autofix:start` | `clients/format-events-publish.ts:94` | `BUS_AUTOFIX_START_EVENT` |

### RPC channels (3)

| Channel | Source file | Export |
|---------|-------------|--------|
| `pilens:rpc:diagnostics` | `clients/rpc-publish.ts:58` | `BUS_RPC_REQUEST_DIAGNOSTICS_EVENT` |
| `pilens:rpc:files-touched` | `clients/rpc-publish.ts:59` | `BUS_RPC_REQUEST_FILES_TOUCHED_EVENT` |
| `pilens:rpc:<token>:response` | `clients/rpc-publish.ts:65` | `rpcResponseChannel(token)` helper |

The token-scoped response channel concatenates `pilens:rpc:` + the token + `:response`. A requester never sees another requester's reply.

### Verification actions

1. Trigger an Edit on a `.ts` file and confirm `pilens:files:touched` fires with `reason: "format"` or `"autofix"`.
2. Trigger a lint dispatch and confirm `pilens:diagnostics` fires with the per-file diagnostic set.
3. Mark a diagnostic via `lens_diagnostic_mark false-positive` and confirm `pilens:diagnostic:disposition` fires with the disposition payload.
4. Defer a format pass (`agent_end` drain) and confirm `pilens:format:queued` then `pilens:format:start` fire on the deferred batch.
5. Run an autofix batch and confirm `pilens:autofix:start` fires.
6. Emit an RPC request from another extension and confirm `pilens:rpc:<token>:response` lands on the token-scoped channel.

## Family 3 - Read-guard markdown

The toggle `readGuard.markdown.frontmatterAlwaysRead` controls whether the read-guard treats YAML frontmatter and GFM tables as already-read content. Default is `true` (always read). Set to `false` to make the read-guard block edits when the model has not read the frontmatter or a table.

The toggle has three seams:

- **Schema and parsing** in `clients/lens-config.ts` at `clients/lens-config.ts:83` (field declaration) and `clients/lens-config.ts:351` (parser).
- **Default and accessor** in `clients/runtime-config.ts:80` (`getMarkdownFrontmatterAlwaysRead`).
- **Consumer** in `clients/read-expansion.ts:256` (parameter), `clients/read-expansion.ts:291` (gate), `clients/read-expansion.ts:355` (recursive fetch).

### Verification actions

1. Open a Markdown file with a YAML frontmatter block, run a small Edit on the body, and confirm no read-guard block fires (toggle `true`).
2. Edit `.pi-lens.json` and set `readGuard.markdown.frontmatterAlwaysRead = false`. Reload the session.
3. Reopen the same Markdown file, edit the body, and confirm the read-guard blocks the edit with the frontmatter-not-read reason.

## Family 4 - Controlled degradation

When the host does not expose `registerEntryRenderer`, the test-runner delivery path degrades cleanly rather than crashing. The degradation record kind is `test-runner-delivery`, declared in the `DegradationKind` union at `clients/degradation-ledger.ts:199` and emitted from `clients/test-runner-delivery.ts:119` and `clients/test-runner-delivery.ts:320`.

The record surfaces in two places:

- **`pilens_health` human section**, rendered through `renderDegradationLines` at `clients/degradation-ledger.ts:1166`.
- **`~/.pi-lens/latency.log`**, in the bounded degradation rollup at session shutdown.

### Verification actions

1. Start a session on a host without `registerEntryRenderer` (an older pi release, or a test fixture with the API removed).
2. Run `lens_test_runner` against a failing test target.
3. Open `pilens_health` and confirm the `test-runner-delivery` row is present in the degradations section.
4. Read `~/.pi-lens/latency.log` and confirm one `degradation_ledger` row carries the `test-runner-delivery` kind.

## S03-S08 recap

Each fix landed in an earlier slice and ships with a regression test. The human action confirms the fix in a real session.

### S03 - Tool registration hardening

The 15-tool count is enforced by `tests/clients/pi-lens-home-hermeticity.test.ts` (and adjacent registration sweeps). Human action: open `/lens-tools` and confirm 8 rows visible at session start, 15 after the model calls `pi_lens_activate_tools` for each lazy tool. Extended shape: `docs/features.md`.

### S04 - Bus event surface

The 6 push exports and 3 RPC exports are pinned by `tests/config/files-touched-bus-conformance.test.ts`, `tests/config/diagnostics-bus-conformance.test.ts`, and `tests/config/rpc-bus-conformance.test.ts`. Human action: attach a console listener and confirm each of the 9 channel names fires for the action listed in Family 2. Extended shape: `docs/features.md`.

### S05 - Trivy compose gating

The IaC gate reads `trivy.compose.enabled` (and the related `trivy.config`) at `clients/trivy-client.ts` and dispatches via `clients/dispatch/runners/trivy-config.ts`. Human action: open a project with a `docker-compose.yml`, edit it, and confirm the dispatcher runs `trivy config` only when the gate is on. Extended shape: `docs/features.md`.

### S06 - Markdown read-guard

The `readGuard.markdown.frontmatterAlwaysRead` toggle is the S06 fix. Human action: toggle the field in `.pi-lens.json`, reload the session, and confirm the read-guard enforces or relaxes the frontmatter-and-table read surface (Family 3). Extended shape: `docs/features.md`.

### S07 - LSP warm-up timeout

When the MCP fresh mode's LSP warm-up call exceeds `PI_LENS_MCP_FRESH_WARMUP_TIMEOUT_MS` (default `10000` ms), the summary embeds `lsp 0 (warmup-timeout, <ms>ms)` instead of a silent zero. The literal `warmup-timeout` shape is defined in `docs/environment-variables.md:194` and `docs/features.md:489`. Human action: trigger a fresh-mode analysis against a project whose LSP cold-start exceeds the budget and confirm the summary shows `warmup-timeout`. Extended shape: `docs/features.md`.

### S08 - Test-runner delivery degradation

The `test-runner-delivery` degradation kind is the S08 fix. Human action: run the verification from Family 4 on a host without `registerEntryRenderer` and confirm the degradation surfaces in `pilens_health`. Extended shape: `docs/features.md`.

## Run-through

The maintainer runs these actions in order. Each action has a single observable outcome.

1. `cd` into a test project (a small TypeScript repo with Markdown files, a `docker-compose.yml`, and a failing test target).
2. Launch `pi` with the fork loaded.
3. Run `/lens-tools` and confirm 8 always-active rows.
4. Edit a `.ts` file in the project and confirm the file format runs (autofix or format).
5. Open a console listener for `pi.events`.
6. Edit the file again and confirm `pilens:files:touched` fires on the console.
7. Edit a Markdown file with a YAML frontmatter block; confirm no read-guard block.
8. Set `readGuard.markdown.frontmatterAlwaysRead = false` in `.pi-lens.json`; reload; re-edit; confirm read-guard block cites the frontmatter.
9. Edit `docker-compose.yml`; confirm `pilens:diagnostics` carries the trivy findings when the gate is on, and silent when off.
10. Run `lens_test_runner` against the failing target on a host without `registerEntryRenderer`; confirm `pilens_health` carries the `test-runner-delivery` row.
11. Call `pi_lens_activate_tools` with each lazy name; confirm `/lens-tools` shows 15 rows.
12. Trigger a fresh-mode analysis with a slow cold LSP; confirm `warmup-timeout` appears in the summary.

When every action returns the expected outcome, the maintainer signs off and proceeds to tag. Any deviation is a release blocker; record it in the next `.changelog/*.md` entry and roll the release only after the regression test lands.
