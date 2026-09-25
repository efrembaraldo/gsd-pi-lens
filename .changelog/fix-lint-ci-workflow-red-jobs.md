---
section: Fixed
---

- **Lint and CI workflows green again** — `lint.yml`'s `complexity (advisory)`
  and `mutation.yml`'s `mutation (advisory)` jobs were missing the gsd-pi SDK
  checkout+build and host-types-restore steps every other type-checking job
  already got, so `npm run build` failed on `@gsd/pi-tui`/`@gsd/pi-coding-agent`
  type errors; `knip.jsonc` didn't exempt those same optional
  peerDependencies, so the standalone `knip (advisory)` job (which never
  installs the gsd-pi SDK) reported them as unresolved every run; and
  `ci.yml`'s `install-test` job still globbed `pi-lens-*.tgz` and referenced
  `$(npm root -g)/pi-lens` in five places, both stale filenames/paths `npm
  pack`/`npm install -g` stopped producing once the package was scoped to
  `@efrembaraldo/gsd-pi-lens`.
