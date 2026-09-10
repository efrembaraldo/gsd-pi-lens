/**
 * Central runtime tuning knobs for pipeline/dispatch behavior.
 * Keep these values in one place so behavior is consistent and easy to tune.
 */

import { toPositiveFinite } from "./env-utils.js";
import {
	getGlobalMarkdownFrontmatterAlwaysRead,
	loadPiLensGlobalConfig,
} from "./lens-config.js";

let _runnerTimeoutFloorCache: number | undefined;

/**
 * Minimum wall-clock budget (ms) for every dispatch runner. Acts as a floor:
 * effective timeout = max(runner.timeoutMs ?? 30_000, runnerTimeoutFloorMs).
 *
 * Resolution order (highest priority first):
 *   1. `dispatch.runnerTimeoutFloorMs` in `~/.pi-lens/config.json`
 *   2. `PI_LENS_RUNNER_TIMEOUT_FLOOR_MS` environment variable
 *   3. 0 (no floor — runner budgets and the 30 s default apply as-is)
 *
 * Lazy + memoized so importing `runtime-config.ts` does not trigger disk IO.
 * The config file is read at most once per process, on first dispatch.
 *
 * @example ~/.pi-lens/config.json
 * ```json
 * { "dispatch": { "runnerTimeoutFloorMs": 180000 } }
 * ```
 *
 * @example env var
 * ```bash
 * PI_LENS_RUNNER_TIMEOUT_FLOOR_MS=180000 pi
 * ```
 */
export function getRunnerTimeoutFloorMs(): number {
	if (_runnerTimeoutFloorCache !== undefined) return _runnerTimeoutFloorCache;
	const config = loadPiLensGlobalConfig();
	const configFloor = toPositiveFinite(config?.dispatch?.runnerTimeoutFloorMs);
	const envFloor = toPositiveFinite(
		process.env.PI_LENS_RUNNER_TIMEOUT_FLOOR_MS,
	);
	_runnerTimeoutFloorCache = Math.max(configFloor, envFloor, 0);
	return _runnerTimeoutFloorCache;
}

/**
 * Test-only: clear the memoized floor so a subsequent call re-reads the
 * config file and env var. Use after mutating either in a test.
 */
export function _resetRunnerTimeoutFloorCacheForTests(): void {
	_runnerTimeoutFloorCache = undefined;
}

let _markdownFrontmatterAlwaysReadCache: boolean | undefined;

/**
 * Whether the markdown read-expansion treats YAML frontmatter and adjacent
 * table rows as part of the enclosing section, so an edit inside them does
 * not trip an out-of-range read-guard warning (`S06/T01`). Defaults `true`
 * — the toggle adds coverage, it does not narrow it. The default lives here,
 * not in the loader, so a malformed config (`undefined` from
 * `getGlobalMarkdownFrontmatterAlwaysRead`) still resolves to the safe
 * backward-compatible value. Reads from
 * `~/.pi-lens/config.json` → `readGuard.markdown.frontmatterAlwaysRead`;
 * the env-var override is intentionally absent — same policy as
 * `getWidgetVisible`/`getFormatMode`, which are config-only.
 *
 * Lazy + memoized so importing `runtime-config.ts` does not trigger disk IO.
 * The config file is read at most once per process, on first markdown
 * expansion. Re-armed at `session_start` via
 * {@link _resetMarkdownFrontmatterAlwaysReadCacheForTests} (and the matching
 * run-level reset in production code paths, when added).
 *
 * @example ~/.pi-lens/config.json
 * ```json
 * { "readGuard": { "markdown": { "frontmatterAlwaysRead": false } } }
 * ```
 */
export function getMarkdownFrontmatterAlwaysRead(): boolean {
	if (_markdownFrontmatterAlwaysReadCache !== undefined) {
		return _markdownFrontmatterAlwaysReadCache;
	}
	const configured = getGlobalMarkdownFrontmatterAlwaysRead();
	// `undefined` means "the key was not present in the config"; coerce at the
	// boundary so the rest of the system never has to. A non-boolean garbage
	// value never reaches here — the loader either coerced or fell back to
	// `undefined` already.
	_markdownFrontmatterAlwaysReadCache = configured ?? true;
	return _markdownFrontmatterAlwaysReadCache;
}

/**
 * Test-only: clear the memoized boolean so a subsequent call re-reads the
 * config file. Use after mutating the config in a test.
 */
export function _resetMarkdownFrontmatterAlwaysReadCacheForTests(): void {
	_markdownFrontmatterAlwaysReadCache = undefined;
}

export const RUNTIME_CONFIG = {
	pipeline: {
		lspMaxFileBytes: 2 * 1024 * 1024,
		lspMaxFileLines: 5000,
		cascadeMaxFiles: 5,
		cascadeMaxDiagnosticsPerFile: 20,
		// Hard cap on how long the pipeline will wait for an LSP client to spawn.
		// Keeps tool_result from blocking the TUI during cold LSP start (e.g.
		// pyright workspace indexing). The LSP server continues spawning in the
		// background; subsequent edits get full diagnostics once it is ready.
		lspSpawnBudgetMs: 5_000,
	},
	dispatch: {
		runnerTimeoutMs: 30_000,
	},
	crashNotice: {
		alwaysShowFirstN: 2,
		showEveryNth: 5,
	},
	reviewGraph: {
		// Deprecated (#776): no longer read by `review-graph/builder.ts`, which
		// now derives its fallback from `project-scale.ts`'s `maxProjectFiles`
		// knob (reproducing this same 1,000 default at the default base). Left
		// in place only in case an external caller still reads the constant.
		maxFiles: 1_000,
		maxFileBytes: 1 * 1024 * 1024,
	},
	turnEnd: {
		maxLines: 20,
		maxChars: 1000,
	},
} as const;
