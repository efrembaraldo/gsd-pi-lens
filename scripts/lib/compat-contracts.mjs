// Pure pattern-matching helpers for scripts/compat-contracts.mjs (#476).
//
// Each contract is verified with a RESILIENT regex against the third-party
// source/dist we depend on — never a line number (those drift on every
// release) — so a wording/formatting change that preserves the same semantic
// shape still passes, and a real behavioral drift still fails. Kept pure and
// side-effect-free (no fs/child_process) so the matching logic itself is
// unit-testable without installing any package; the orchestration script
// (compat-contracts.mjs) owns the npm install + file reads and just calls
// these functions with file contents.
//
// The four SDK contracts (2a-2d) pin the @gsd re-scoped SDK. In the @gsd
// world the SDK is a gsd-pi monorepo workspace (packages @gsd/pi-coding-agent
// and @gsd/agent-core), not a standalone npm package — the orchestration
// script reads the dist sources directly from a gsd-pi checkout, never via
// `npm install @gsd/`. The resized-lifetime files:
//   - 2a  @gsd/pi-coding-agent  packages/pi-coding-agent/dist/core/extensions/loader.js
//   - 2b  @gsd/agent-core       packages/gsd-agent-core/dist/session/agent-session-extensions.js
//   - 2c  @gsd/agent-core       packages/gsd-agent-core/dist/session/agent-session-events.js
//   - 2d  @gsd/pi-coding-agent  packages/pi-coding-agent/dist/core/extensions/runner.js

/**
 * Contract 1 (nicobailon/pi-subagents): the child-process env var names the
 * extension sets on every spawned subagent. We depend on `PI_SUBAGENT_CHILD`
 * being set to the literal string `"1"` (subagent-mode.ts reads it that way),
 * plus the run-id/child-agent-name identity vars existing in the same file
 * (best-effort identity surfaced in the latency log — absence degrades to
 * "unknown", never breaks). Verified against `src/runs/shared/pi-args.ts`.
 *
 * @param {string} source contents of pi-args.ts (or wherever the child env is built)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkNicobailonChildEnv(source) {
	const setsChildFlag =
		/env(?:\[[^\]]+\]|\.\w+)\s*=\s*["']1["']/.test(source) &&
		/SUBAGENT_CHILD_ENV\s*=\s*["']PI_SUBAGENT_CHILD["']/.test(source);
	const hasRunId = /SUBAGENT_RUN_ID_ENV\s*=\s*["']PI_SUBAGENT_RUN_ID["']/.test(
		source,
	);
	const hasChildAgent =
		/SUBAGENT_CHILD_AGENT_ENV\s*=\s*["']PI_SUBAGENT_CHILD_AGENT["']/.test(
			source,
		);
	const pass = setsChildFlag && hasRunId && hasChildAgent;
	return {
		pass,
		detail: pass
			? "PI_SUBAGENT_CHILD='1' set unconditionally; PI_SUBAGENT_RUN_ID + PI_SUBAGENT_CHILD_AGENT present"
			: `missing: ${[
					!setsChildFlag && "PI_SUBAGENT_CHILD='1' assignment",
					!hasRunId && "PI_SUBAGENT_RUN_ID const",
					!hasChildAgent && "PI_SUBAGENT_CHILD_AGENT const",
				]
					.filter(Boolean)
					.join(", ")}`,
	};
}

/**
 * Contract 1b (avtc-pi-subagent): the spawn-env pair set on every real
 * child-process `pi` spawn — `PI_SUBAGENT_CHILD_AGENT` (the agent's name,
 * assigned to the spawn env when the agent has one) and
 * `PI_SUBAGENT_PARENT_PID` (unconditionally `String(process.pid)`).
 * `subagent-mode.ts`'s `classifySubagentSession()` requires the PAIR (both
 * non-empty) to detect this vocabulary — a lone var must not trip light
 * mode — so this check asserts BOTH assignments exist, not either alone.
 * Verified against `avtc-pi-subagent@1.0.3` — `src/process-runner.ts`.
 *
 * @param {string} source contents of process-runner.ts (or wherever the
 *   per-spawn subagent env is built)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkAvtcChildEnv(source) {
	const setsChildAgent = /\w+\.PI_SUBAGENT_CHILD_AGENT\s*=/.test(source);
	const setsParentPid =
		/\w+\.PI_SUBAGENT_PARENT_PID\s*=\s*String\(\s*process\.pid\s*\)/.test(
			source,
		);
	const pass = setsChildAgent && setsParentPid;
	return {
		pass,
		detail: pass
			? "PI_SUBAGENT_CHILD_AGENT + PI_SUBAGENT_PARENT_PID both assigned on the per-spawn subagent env"
			: `missing: ${[
					!setsChildAgent && "PI_SUBAGENT_CHILD_AGENT assignment",
					!setsParentPid &&
						"PI_SUBAGENT_PARENT_PID = String(process.pid) assignment",
				]
					.filter(Boolean)
					.join(", ")}`,
	};
}

/**
 * Contract 2a (@gsd/pi-coding-agent): the extension loader keeps a
 * module-scope cache (`const _moduleImporters = new Map()`), consulted
 * through `.get()`/`.set()` per parent module URL. This is what makes an
 * in-process `bindExtensions()` reuse pi-lens's own module-scope singletons
 * instead of a fresh isolated instance — the root cause #473 guards against.
 * Renamed from the pre-@gsd `extensionCache` but semantically unchanged.
 * Verified against `packages/pi-coding-agent/dist/core/extensions/loader.js`.
 *
 * @param {string} source contents of the extension loader dist file
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkSdkExtensionCache(source) {
	const hasCache = /_moduleImporters\s*=\s*new Map\(\)/.test(source);
	const consultsGet = /_moduleImporters\.get\(/.test(source);
	const consultsSet = /_moduleImporters\.set\(/.test(source);
	const pass = hasCache && consultsGet && consultsSet;
	return {
		pass,
		detail: pass
			? "module-scope `_moduleImporters = new Map()` present and consulted via `.get()`/`.set()`"
			: `no module-scope \`_moduleImporters\` Map cache consulted via \`.get()\`/\`.set()\` in the extension loader${
				!hasCache
					? " (no `_moduleImporters = new Map()` declaration found)"
					: ""
			}`,
	};
}

/**
 * Contract 2b (@gsd/agent-core): `bindExtensions()` unconditionally emits a
 * `session_start`-typed event — `this.host._extensionRunner.emit(
 * this.host._sessionStartEvent)`. This is why an in-process subagent bind
 * re-triggers pi-lens's `session_start` handler at all. Fail-closed when the
 * method is absent. Verified against `packages/gsd-agent-core/dist/session/
 * agent-session-extensions.js`.
 *
 * @param {string} source contents of agent-session-extensions.js
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkSdkBindExtensionsEmitsSessionStart(source) {
	const bindMatch = source.match(
		/async bindExtensions\([^)]*\)\s*\{([\s\S]*?)\n\s{4}\}/,
	);
	if (!bindMatch) {
		return { pass: false, detail: "bindExtensions() method not found" };
	}
	const body = bindMatch[1];
	const pass =
		/this\.host\._extensionRunner\.emit\(\s*this\.host\._sessionStartEvent\s*\)/.test(
			body,
		);
	return {
		pass,
		detail: pass
			? "bindExtensions() unconditionally emits this.host._extensionRunner.emit(this.host._sessionStartEvent)"
			: "bindExtensions() body does not emit this.host._extensionRunner.emit(this.host._sessionStartEvent)",
	};
}

/**
 * Contract 2c (@gsd/agent-core): `this.host._extensionRunner.invalidate(`
 * is called from the sequential session-replacement path (newSession/fork/
 * switchSession/reload's dispose route) — the mechanism `probeCtxActive()`
 * in session-lifecycle.ts relies on to distinguish a stale (replaced) ctx
 * from a live concurrent one. Verified against `packages/gsd-agent-core/
 * dist/session/agent-session-events.js`.
 *
 * @param {string} source contents of agent-session-events.js
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkSdkInvalidateCalled(source) {
	const pass = /this\.host\._extensionRunner\.invalidate\(/.test(source);
	return {
		pass,
		detail: pass
			? "this.host._extensionRunner.invalidate(...) call site found"
			: "no this.host._extensionRunner.invalidate(...) call site found",
	};
}

/**
 * Contract 2d (@gsd/pi-coding-agent): the stale-ctx error message contains
 * the exact fragment `session-lifecycle.ts`'s `probeCtxActive()` matches on.
 * If this wording changes upstream, the probe silently degrades to
 * "inconclusive" (fail-safe = sequential-replacement, never a false
 * concurrent-secondary), but that's exactly the drift we want the nightly to
 * flag loudly. Verified against the `invalidate(...)` default-param message
 * in `packages/pi-coding-agent/dist/core/extensions/runner.js` (the canonical
 * source; the message also appears in agent-session-events.js's dispose call).
 *
 * @param {string} source contents of runner.js (or any file carrying the
 *   stale-ctx invalidate message)
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkSdkStaleCtxMessage(source) {
	const pass = source.includes("stale after session replacement");
	return {
		pass,
		detail: pass
			? 'stale-ctx message contains "stale after session replacement"'
			: 'stale-ctx message fragment "stale after session replacement" NOT found — probeCtxActive() in clients/session-lifecycle.ts will silently degrade to inconclusive',
	};
}

/**
 * Contract 3 (tintinweb/pi-subagents): constructs a `DefaultResourceLoader`
 * and calls `session.bindExtensions(...)` on a freshly created
 * `AgentSession` — the in-process model #473's concurrent-session guard
 * exists to protect against. Verified against `src/agent-runner.ts`.
 *
 * @param {string} source contents of agent-runner.ts
 * @returns {{ pass: boolean, detail: string }}
 */
export function checkTintinwebInProcessBind(source) {
	const usesResourceLoader = /new DefaultResourceLoader\(/.test(source);
	const callsBindExtensions =
		/\bbindExtensions\(\{/.test(source) || /\.bindExtensions\(/.test(source);
	const pass = usesResourceLoader && callsBindExtensions;
	return {
		pass,
		detail: pass
			? "constructs DefaultResourceLoader + calls session.bindExtensions() in-process"
			: `missing: ${[
					!usesResourceLoader && "`new DefaultResourceLoader(...)`",
					!callsBindExtensions && "`.bindExtensions(...)` call",
				]
					.filter(Boolean)
					.join(", ")}`,
	};
}

/**
 * Run every contract check and return a combined report. Each entry name
 * matches what the workflow step / alert-issue body prints, so a failure is
 * traceable straight back to a specific dependency + source file.
 *
 * The four SDK inputs map to files read from a gsd-pi checkout:
 *   - sdkLoaderSource                 .../pi-coding-agent/dist/core/extensions/loader.js
 *   - sdkRunnerSource                 .../pi-coding-agent/dist/core/extensions/runner.js
 *   - sdkAgentSessionExtensionsSource .../gsd-agent-core/dist/session/agent-session-extensions.js
 *   - sdkAgentSessionEventsSource     .../gsd-agent-core/dist/session/agent-session-events.js
 *
 * @param {{
 *   nicobailonPiArgsSource: string,
 *   avtcProcessRunnerSource: string,
 *   sdkLoaderSource: string,
 *   sdkRunnerSource: string,
 *   sdkAgentSessionExtensionsSource: string,
 *   sdkAgentSessionEventsSource: string,
 *   tintinwebAgentRunnerSource: string,
 * }} inputs
 */
export function runAllContractChecks(inputs) {
	const results = [
		{
			id: "nicobailon.child-env",
			package: "pi-subagents",
			description:
				"PI_SUBAGENT_CHILD/RUN_ID/CHILD_AGENT env vars set on every spawned child",
			...checkNicobailonChildEnv(inputs.nicobailonPiArgsSource),
		},
		{
			id: "avtc.child-env",
			package: "avtc-pi-subagent",
			description:
				"PI_SUBAGENT_CHILD_AGENT + PI_SUBAGENT_PARENT_PID pair set on every spawned child",
			...checkAvtcChildEnv(inputs.avtcProcessRunnerSource),
		},
		{
			id: "sdk.extension-cache",
			package: "@gsd/pi-coding-agent",
			description: "module-scope _moduleImporters Map in the extension loader",
			...checkSdkExtensionCache(inputs.sdkLoaderSource),
		},
		{
			id: "sdk.bind-extensions-session-start",
			package: "@gsd/agent-core",
			description:
				"bindExtensions() unconditionally emits this.host._sessionStartEvent",
			...checkSdkBindExtensionsEmitsSessionStart(
				inputs.sdkAgentSessionExtensionsSource,
			),
		},
		{
			id: "sdk.invalidate-called",
			package: "@gsd/agent-core",
			description:
				"invalidate() called from the sequential session-replacement path",
			...checkSdkInvalidateCalled(inputs.sdkAgentSessionEventsSource),
		},
		{
			id: "sdk.stale-ctx-message",
			package: "@gsd/pi-coding-agent",
			description:
				'stale-ctx error message contains "stale after session replacement"',
			...checkSdkStaleCtxMessage(inputs.sdkRunnerSource),
		},
		{
			id: "tintinweb.in-process-bind",
			package: "@tintinweb/pi-subagents",
			description:
				"constructs DefaultResourceLoader + calls bindExtensions() in-process",
			...checkTintinwebInProcessBind(inputs.tintinwebAgentRunnerSource),
		},
	];
	const allPass = results.every((r) => r.pass);
	return { results, allPass };
}