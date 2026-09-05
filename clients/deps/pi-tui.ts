/**
 * Centralized accessor for `@gsd/pi-tui`, routed through here for a uniform
 * dep surface. pi-tui is a gsd-pi-bundled core package: the host resolves the
 * bare specifier from its own runtime, so pi-lens declares it as an OPTIONAL
 * peer (never a runtime dependency). A runtime dependency would make
 * `npm install --omit=dev` vendor a private second copy that Node evaluates
 * at import — ~97ms of the 838ms git-install module import in #1926.
 *
 * Resolution under this fork: type-side via `vendor/pi-tui` (pinned by
 * `tsconfig.json`'s `@gsd/pi-tui` path mapping), runtime-side via
 * `scripts/setup-types.mjs`'s "runtime materialization" stage that copies the
 * checkout's `packages/pi-tui/dist/` into `node_modules/@gsd/pi-tui/` on every
 * clone and after any `npm install` that may prune extraneous packages.
 * `scripts/lib/host-provided-deps.mjs` holds the peer-list, and
 * `tests/packaging.test.ts` pins the declaration.
 *
 * Re-export named bindings, not `export *`: with the package kept external, a
 * wildcard re-export leaves the namespace undefined at runtime under the bundle.
 */

export type { Component } from "@gsd/pi-tui";
export { Text, truncateToWidth, visibleWidth } from "@gsd/pi-tui";
