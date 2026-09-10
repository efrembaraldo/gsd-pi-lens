/**
 * R009 / S07/T02 — bus-pull RPC request/response surface over the shared
 * `pi.events` bus.
 *
 * pi's `pi.events` is a plain EventEmitter: it has no native request/response
 * semantics. Two callers can race an emit, neither knows whether the other
 * heard it, and a request never gets an answer. This module closes that gap
 * by reserving two request event names — `pilens:rpc:diagnostics` and
 * `pilens:rpc:files-touched` — and emitting a correlated response on
 * `pilens:rpc:<token>:response` for every well-formed request.
 *
 * **Why a sibling module, not a fold into `clients/bus-publish.ts` /
 * `clients/diagnostics-publish.ts`:** the push publisher (#482 / #502) owns
 * its own module state (`reportedDirtyPaths`, `seqCounter`) and the frozen
 * `PilensDiagnosticsPayload` shape. Mixing the request/response plumbing into
 * either would tangle the fire-and-forget push surface with a stateful
 * request map keyed by token. The RPC handler is a CONSUMER of the same
 * diagnostics state the push publisher WRITES, not a duplicate of it — it
 * reads `PilensDiagnosticsPayload` verbatim and emits a thin wrapper that
 * carries the token, TTL and an optional `expired` flag.
 *
 * **No new IPC / JSON-RPC runtime.** Only subscribers/publishers on the
 * already-wired `pi.events` bus. The MCP mirror and the host's print/RPC
 * modes do not wire `pi.events`, so the handler is a structural no-op there
 * (a guard on `typeof events?.on === "function"`) — the request never gets
 * a response, and the requester is expected to time out on its own side.
 *
 * **Staleness / replace semantics** for `PilensDiagnosticsPayload` are the
 * push publisher's contract (#502, this file's sibling): full-replace per
 * path, explicit empty = clean, monotonic `seq`. The RPC layer reuses the
 * shape verbatim and adds nothing.
 *
 * Token validation:
 *   - `typeof token !== "string"` → no-op + `rpc_request_invalid_no_token`.
 *   - `token.length < 1 || token.length > 128` → same.
 *
 * TTL (`PI_LENS_RPC_RESPONSE_TTL_MS`, default 5000ms, via
 * {@link getRpcResponseTtlMs}) is evaluated once per request at emit time.
 * In the current synchronous handler the elapsed window is microseconds —
 * the path exists for the future async case and for tests that force the
 * boundary by stamping the receipt timestamp artificially.
 */

import { isBusPublishEnabled } from "./bus-publish.js";
import { logBusEvent } from "./bus-events-logger.js";
import {
	MAX_DIAGNOSTICS_PER_FILE_EVENT,
	type PilensDiagnosticsFileEntry,
	type PilensDiagnosticsPayload,
} from "./diagnostics-publish.js";
import {
	getRpcMaxDiagnosticsPerResponse,
	getRpcResponseTtlMs,
} from "./runtime-config.js";

// --- Event names + version ---

export const BUS_RPC_REQUEST_DIAGNOSTICS_EVENT = "pilens:rpc:diagnostics";
export const BUS_RPC_REQUEST_FILES_TOUCHED_EVENT = "pilens:rpc:files-touched";
export const BUS_RPC_RESPONSE_VERSION = 1;

/** Internal helper — every response lands on a per-token channel so multiple
 *  concurrent requesters never see each other's replies. */
function rpcResponseChannel(token: string): string {
	return `pilens:rpc:${token}:response`;
}

/** `events` shape we need. Typed as the minimal subset pi exposes so a unit
 *  test double does not need to model the full `ExtensionAPI`. Method
 *  parameter names are deliberately unique across the interface to keep
 *  oxlint's `no-dupe-args` happy (it scans interface members as a flat list
 *  in this codebase). `emit` returns `void` to match pi's `pi.events.emit`
 *  (the underlying EventEmitter returns `boolean`, but pi-lens never
 *  consumes that return — callers in `clients/bus-publish.ts` and
 *  `clients/agent-nudge.ts` discard it too — so the wider structural type
 *  lines up against the host's bus without a cast at the call site). */
export interface BusEventsLike {
	on(eventName: string, onHandler: (data: unknown) => void): void;
	off?(eventName: string, offHandler: (data: unknown) => void): void;
	emit(eventName: string, emitData: unknown): void;
}

// --- Module state ---

/**
 * Per-token receipt timestamps. The TTL check reads the value at emit time;
 * see the module doc for why this is structurally a no-op today and
 * load-bearing under a future async handler.
 *
 * Bounded by `pendingRequestTtl` (lazy cleanup): on every new receipt we drop
 * entries whose `Date.now() - ts > ttl` so the map never accumulates dead
 * state for tokens that never got a response (a host bug or a malicious
 * emitter could otherwise grow the map unboundedly).
 */
const requestReceivedAt = new Map<string, number>();

/** Last `events` object the subscriber was wired against, plus the two
 *  listener references, so a re-wire can detach the old listeners before
 *  attaching the new ones (idempotent + leak-free across session resets). */
interface WiredSubscription {
	events: BusEventsLike;
	diagnosticsListener: (data: unknown) => void;
	filesTouchedListener: (data: unknown) => void;
}
let lastWired: WiredSubscription | undefined;

// --- Public types ---

/**
 * Per-file recent-touched entry the RPC files-touched handler reads. The
 * subscriber accepts any function returning a structurally-compatible array;
 * the canonical producer is `clients/agent-nudge.ts`'s accumulator
 * (`Record<string, {path, ts}>` shape normalized to an array here).
 */
export interface PilensRpcRecentTouchEntry {
	path: string;
	ts: number;
}

/** Files-touched RPC payload — kept inline (no shared shape with the push
 *  publisher; #482's payload is `paths[]` + `reason` + optional `fixes`, and
 *  a pull consumer usually wants paths + ts, not a "why"). */
export interface PilensRpcFilesTouchedPayload {
	paths: string[];
	ts: number;
}

/** Generic envelope for any RPC response: token + ttl + payload + optional
 *  `expired` flag. `T` is the typed inner payload — for diagnostics it's
 *  `PilensDiagnosticsPayload`, for files-touched it's
 *  `PilensRpcFilesTouchedPayload`. The two envelopes share the same wire
 *  shape so a consumer can route on `event === "pilens:rpc:<token>:response"`
 *  and dispatch on the inner `payload` field alone. */
export interface PilensRpcResponsePayload<T> {
	v: typeof BUS_RPC_RESPONSE_VERSION;
	source: "pi-lens";
	token: string;
	ttlMs: number;
	payload: T;
	/** Set only when the request's TTL elapsed before state could be read or
	 *  the response could be emitted. The inner payload is an empty
	 *  `{diagnostics: []}` (diagnostics) or `{paths: [], ts: 0}` (files
	 *  touched) so a caller can use the same code path. */
	expired?: true;
}

/** Envelope sent on the bus — duck-typed so the producer side does not
 *  have to know whether the caller is on a `PilensDiagnosticsPayload`
 *  version or a future variant. */
export interface RpcRequestEnvelope {
	v: number;
	source: string;
	token: string;
	paths?: string[];
}

/** Diagnostics getter — returns the file-level entries to ship back, already
 *  with the per-file `MAX_DIAGNOSTICS_PER_FILE_EVENT` cap applied (same
 *  shape the push publisher emits, so a requester can compare both
 *  deliveries without translating). Returns `undefined` to signal
 *  "no state available" (the handler will emit the empty-state response). */
export type GetDiagnosticsState = () =>
	| PilensDiagnosticsFileEntry[]
	| undefined
	| null;

/** Files-touched getter — returns the in-process accumulator's entries. */
export type GetRecentTouches = () => PilensRpcRecentTouchEntry[];

export interface WireRpcBusSubscriberArgs {
	events: BusEventsLike | undefined;
	getDiagnosticsState: GetDiagnosticsState;
	getRecentTouches: GetRecentTouches;
	/** Optional debug sink, same shape every other bus publisher uses. */
	dbg?: (msg: string) => void;
}

// --- Helpers ---

const TOKEN_MAX_LENGTH = 128;

function isValidToken(token: unknown): token is string {
	return (
		typeof token === "string" &&
		token.length >= 1 &&
		token.length <= TOKEN_MAX_LENGTH
	);
}

function isValidRpcRequest(data: unknown): data is RpcRequestEnvelope {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.v !== "number") return false;
	if (typeof d.source !== "string") return false;
	if (typeof d.token !== "string") return false;
	if (d.paths !== undefined) {
		if (!Array.isArray(d.paths)) return false;
		if (!d.paths.every((p) => typeof p === "string")) return false;
	}
	return true;
}

/**
 * Apply the per-response cap to a `PilensDiagnosticsPayload.files` array.
 * Walks entries in order; once adding the next entry would exceed the cap,
 * the previous entry is truncated (and marked `truncated: true`) to fit,
 * and the rest is dropped. Returns the truncated entry set; the consumer
 * preserves the original `seq`/`ts`/`cwd` from the producer.
 *
 * Mirrors the truncation spirit of `MAX_DIAGNOSTICS_PER_FILE_EVENT` (the
 * push publisher caps per-file at 12); this cap is the GLOBAL ceiling, so
 * one file's bloated diagnostic set cannot crowd out every other file.
 */
function capDiagnosticsFiles(
	files: PilensDiagnosticsFileEntry[],
	maxDiagnostics: number,
): PilensDiagnosticsFileEntry[] {
	if (files.length === 0 || maxDiagnostics <= 0) return [];
	const out: PilensDiagnosticsFileEntry[] = [];
	let remaining = maxDiagnostics;
	for (const entry of files) {
		if (remaining <= 0) break;
		const len = entry.diagnostics.length;
		if (len <= remaining) {
			out.push(entry);
			remaining -= len;
			continue;
		}
		// Partial-fit: keep this entry, trim its diagnostics to the remaining
		// budget, mark truncated so the consumer knows this file is partial.
		out.push({
			path: entry.path,
			diagnostics: entry.diagnostics.slice(0, remaining),
			truncated: true,
		});
		remaining = 0;
	}
	return out;
}

/** Bound the in-memory request-timestamp cache: drop entries whose age
 *  exceeds the TTL on every new receipt so the map never grows unbounded. */
function pruneStaleRequestTimestamps(ttlMs: number): void {
	if (requestReceivedAt.size === 0) return;
	const now = Date.now();
	for (const [token, ts] of requestReceivedAt) {
		if (now - ts > ttlMs) requestReceivedAt.delete(token);
	}
}

// --- Handler internals ---

interface HandleDiagnosticsCtx {
	events: BusEventsLike;
	receivedAt: number;
	getDiagnosticsState: GetDiagnosticsState;
	dbg?: (msg: string) => void;
}

function buildDiagnosticsPayload(
	ctx: HandleDiagnosticsCtx,
	paths: string[] | undefined,
	cwd: string,
): PilensDiagnosticsPayload {
	const state = ctx.getDiagnosticsState();
	const allFiles = state ?? [];
	const filtered =
		paths && paths.length > 0
			? allFiles.filter((f) => paths.includes(f.path))
			: allFiles;
	const maxDiag = getRpcMaxDiagnosticsPerResponse();
	const cappedFiles = capDiagnosticsFiles(filtered, maxDiag);
	return {
		v: 1, // BUS_DIAGNOSTICS_VERSION lives in diagnostics-publish.ts; pin the literal here so the wire shape stays decoupled.
		source: "pi-lens",
		cwd,
		seq: 0, // RPC responses are point-in-time snapshots, not part of the push publisher's monotonic stream.
		ts: ctx.receivedAt,
		files: cappedFiles,
	};
}

function handleDiagnosticsRequest(
	rawData: unknown,
	ctx: HandleDiagnosticsCtx,
): void {
	if (!isValidRpcRequest(rawData)) {
		logBusEvent({
			event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
			outcome: "rpc_request_invalid_no_token",
			cwd: "",
		});
		return;
	}
	const { token, paths } = rawData;
	if (!isValidToken(token)) {
		logBusEvent({
			event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
			outcome: "rpc_request_invalid_no_token",
			cwd: "",
		});
		return;
	}
	logBusEvent({
		event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
		outcome: "rpc_request_received",
		cwd: "",
	});
	requestReceivedAt.set(token, ctx.receivedAt);

	const ttlMs = getRpcResponseTtlMs();
	if (Date.now() - ctx.receivedAt > ttlMs) {
		const wrapper: PilensRpcResponsePayload<PilensDiagnosticsPayload> = {
			v: BUS_RPC_RESPONSE_VERSION,
			source: "pi-lens",
			token,
			ttlMs,
			expired: true,
			payload: {
				v: 1,
				source: "pi-lens",
				cwd: "",
				seq: 0,
				ts: ctx.receivedAt,
				files: [],
			},
		};
		emitRpcResponse(ctx.events, token, wrapper, ctx.dbg);
		logBusEvent({
			event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
			outcome: "rpc_response_expired_no_state",
			cwd: "",
		});
		return;
	}

	const state = ctx.getDiagnosticsState();
	if (!state || (Array.isArray(state) && state.length === 0)) {
		const wrapper: PilensRpcResponsePayload<PilensDiagnosticsPayload> = {
			v: BUS_RPC_RESPONSE_VERSION,
			source: "pi-lens",
			token,
			ttlMs,
			payload: {
				v: 1,
				source: "pi-lens",
				cwd: "",
				seq: 0,
				ts: ctx.receivedAt,
				files: [],
			},
		};
		emitRpcResponse(ctx.events, token, wrapper, ctx.dbg);
		logBusEvent({
			event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
			outcome: "rpc_response_skipped_no_state",
			cwd: "",
		});
		return;
	}

	const payload = buildDiagnosticsPayload(ctx, paths, "");
	const wrapper: PilensRpcResponsePayload<PilensDiagnosticsPayload> = {
		v: BUS_RPC_RESPONSE_VERSION,
		source: "pi-lens",
		token,
		ttlMs,
		payload,
	};
	emitRpcResponse(ctx.events, token, wrapper, ctx.dbg);
	logBusEvent({
		event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
		outcome: "rpc_response_emitted",
		cwd: payload.cwd,
		fileCount: payload.files.reduce((s, f) => s + f.diagnostics.length, 0),
	});
}

function handleFilesTouchedRequest(
	rawData: unknown,
	ctx: HandleDiagnosticsCtx & { getRecentTouches: GetRecentTouches },
): void {
	if (!isValidRpcRequest(rawData)) {
		logBusEvent({
			event: BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
			outcome: "rpc_request_invalid_no_token",
			cwd: "",
		});
		return;
	}
	const { token, paths } = rawData;
	if (!isValidToken(token)) {
		logBusEvent({
			event: BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
			outcome: "rpc_request_invalid_no_token",
			cwd: "",
		});
		return;
	}
	logBusEvent({
		event: BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
		outcome: "rpc_request_received",
		cwd: "",
	});
	requestReceivedAt.set(token, ctx.receivedAt);

	const ttlMs = getRpcResponseTtlMs();
	const innerPayload: PilensRpcFilesTouchedPayload =
		Date.now() - ctx.receivedAt > ttlMs
			? { paths: [], ts: 0 }
			: buildFilesTouchedPayload(ctx, paths);
	const wrapper: PilensRpcResponsePayload<PilensRpcFilesTouchedPayload> = {
		v: BUS_RPC_RESPONSE_VERSION,
		source: "pi-lens",
		token,
		ttlMs,
		...(Date.now() - ctx.receivedAt > ttlMs ? { expired: true as const } : {}),
		payload: innerPayload,
	};
	if (wrapper.expired) {
		emitRpcResponse(ctx.events, token, wrapper, ctx.dbg);
		logBusEvent({
			event: BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
			outcome: "rpc_response_expired_no_state",
			cwd: "",
		});
		return;
	}

	emitRpcResponse(ctx.events, token, wrapper, ctx.dbg);
	logBusEvent({
		event: BUS_RPC_REQUEST_FILES_TOUCHED_EVENT,
		outcome: "rpc_response_emitted",
		cwd: "",
		fileCount: innerPayload.paths.length,
	});
}

function buildFilesTouchedPayload(
	ctx: HandleDiagnosticsCtx & { getRecentTouches: GetRecentTouches },
	paths: string[] | undefined,
): PilensRpcFilesTouchedPayload {
	const entries = ctx.getRecentTouches() ?? [];
	const filtered =
		paths && paths.length > 0
			? entries.filter((e) => paths.includes(e.path))
			: entries;
	if (filtered.length === 0) {
		return { paths: [], ts: Date.now() };
	}
	const maxTs = filtered.reduce((acc, e) => (e.ts > acc ? e.ts : acc), 0);
	return {
		paths: filtered.map((e) => e.path),
		ts: maxTs > 0 ? maxTs : Date.now(),
	};
}

function emitRpcResponse<T>(
	events: BusEventsLike,
	token: string,
	wrapper: PilensRpcResponsePayload<T>,
	dbg?: (msg: string) => void,
): void {
	try {
		events.emit(rpcResponseChannel(token), wrapper);
	} catch (err) {
		logBusEvent({
			event: BUS_RPC_REQUEST_DIAGNOSTICS_EVENT,
			outcome: "rpc_response_failed",
			cwd: "",
			error: String(err),
		});
		dbg?.(`rpc-publish: emit failed on ${rpcResponseChannel(token)}: ${err}`);
	}
}

// --- Public surface ---

/**
 * Wire the RPC request handlers against a `pi.events`-like object. Called
 * once at extension factory time from index.ts (sibling of
 * `wireBusEmitter` / `wireDiagnosticsBusEmitter`); subsequent calls with the
 * same `events` object are no-ops, calls with a different `events` object
 * detach the previous listeners first.
 *
 * Feature-detects `events.on` / `events.emit`: a host that exposes a partial
 * bus (or none at all, as the MCP mirror and unit tests do) is a structural
 * no-op — the module never throws and never logs on the missing-bus path,
 * matching the #482 / #502 publishers' behavior.
 *
 * The kill switch `PI_LENS_BUS_PUBLISH=0` is honored at emit time, NOT at
 * wire time: the subscribers stay registered (so a request still finds a
 * listener if the switch is toggled on mid-session), but the handlers
 * return without emitting when the switch is off. There is no log on the
 * "publish disabled" path because every RPC request would otherwise spam
 * one identical `skipped_disabled` line per request.
 */
export function wireRpcBusSubscriber(args: WireRpcBusSubscriberArgs): void {
	const { events } = args;
	if (!events || typeof events.on !== "function") return;
	if (
		lastWired &&
		lastWired.events === events &&
		typeof lastWired.events.off === "function"
	) {
		// Already wired against this same `events` object — no-op so a
		// repeated factory activation does not stack duplicate listeners.
		return;
	}
	if (lastWired && typeof lastWired.events.off === "function") {
		lastWired.events.off(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, lastWired.diagnosticsListener);
		lastWired.events.off(BUS_RPC_REQUEST_FILES_TOUCHED_EVENT, lastWired.filesTouchedListener);
	}

	const diagnosticsListener = (rawData: unknown) => {
		if (!isBusPublishEnabled()) return;
		const receivedAt = Date.now();
		pruneStaleRequestTimestamps(getRpcResponseTtlMs());
		handleDiagnosticsRequest(rawData, {
			events,
			receivedAt,
			getDiagnosticsState: args.getDiagnosticsState,
			dbg: args.dbg,
		});
	};
	const filesTouchedListener = (rawData: unknown) => {
		if (!isBusPublishEnabled()) return;
		const receivedAt = Date.now();
		pruneStaleRequestTimestamps(getRpcResponseTtlMs());
		handleFilesTouchedRequest(rawData, {
			events,
			receivedAt,
			getDiagnosticsState: args.getDiagnosticsState,
			getRecentTouches: args.getRecentTouches,
			dbg: args.dbg,
		});
	};

	events.on(BUS_RPC_REQUEST_DIAGNOSTICS_EVENT, diagnosticsListener);
	events.on(BUS_RPC_REQUEST_FILES_TOUCHED_EVENT, filesTouchedListener);
	lastWired = { events, diagnosticsListener, filesTouchedListener };
}

/** Test-only: drop every piece of module state so a subsequent
 *  `wireRpcBusSubscriber` call starts from a clean slate. Pair with
 *  `_resetRpcCacheForTests` (`clients/runtime-config.ts`) so the env-memo
 *  knobs also reset. */
export function _resetRpcPublishForTests(): void {
	requestReceivedAt.clear();
	lastWired = undefined;
}

// Re-export for tests / docs that need the per-file cap the handler enforces.
export { MAX_DIAGNOSTICS_PER_FILE_EVENT };
