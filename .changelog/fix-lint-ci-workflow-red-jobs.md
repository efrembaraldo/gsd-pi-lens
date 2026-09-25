---
section: Fixed
---

- **Lint and CI workflows green again** — `lint.yml`'s `complexity (advisory)`
  and `mutation.yml`'s `mutation (advisory)` jobs were missing the gsd-pi SDK
  checkout+build and host-types-restore steps every other type-checking job
  already got, so `npm run build` failed on `@gsd/pi-tui`/`@gsd/pi-coding-agent`
  type errors; `knip.jsonc` didn't exempt those same optional
  peerDependencies, so the standalone `knip (advisory)` job (which never
  installs the gsd-pi SDK) reported them as unresolved every run; `ci.yml`'s
  `install-test` job still globbed `pi-lens-*.tgz` and referenced
  `$(npm root -g)/pi-lens` in five places, both stale filenames/paths `npm
  pack`/`npm install -g` stopped producing once the package was scoped to
  `@efrembaraldo/gsd-pi-lens`; and, once those were fixed, `install-test`'s
  "Supply host-provided packages" step turned out to have never actually
  worked — it tried `npm install @gsd/pi-tui@^1.19.0` straight from the
  public registry, but `@gsd/pi-tui` is a workspace-only package inside the
  gsd-pi monorepo, never published standalone (confirmed E404). Fixed by
  extracting it from a real `npm install @opengsd/gsd-pi` instead, which
  vendors the same package nested under its own `node_modules`
  (`scripts/supply-host-provided-deps.mjs`'s new `--install <dir>` mode).
