---
title: Tarball missing dist-local openclaw.plugin.json
created: 2026-04-14T15:17:54Z
area: installer
priority: high
---

## Problem

`scripts/build-tarball.mjs` ships `openclaw.plugin.json` at the tarball root only. The installer creates the openclaw plugin symlink `~/.openclaw/extensions/aof → $INSTALL_DIR/dist/`, so openclaw's plugin loader looks for the manifest at `$INSTALL_DIR/dist/openclaw.plugin.json` — which doesn't exist in installed tarballs. Result: fresh installer runs from v1.13+ produce a gateway that refuses to load the AOF plugin with `plugins.entries.aof: plugin not found: aof`.

Dev `npm run deploy` papers over this via `scripts/copy-extension-entry.js` which writes a dist-local manifest copy with `.main = "plugin.js"`. The tarball builder needs to do the same before tar'ing.

Observed: 2026-04-14 v1.14.1 upgrade — only worked because a stale `dist/openclaw.plugin.json` from a prior `npm run deploy` happened to sit under the symlink target.

## Solution

In `scripts/build-tarball.mjs` after copying `dist/` into staging, emit a dist-local manifest:

```js
const manifest = JSON.parse(readFileSync(join(staging, 'openclaw.plugin.json'), 'utf8'));
manifest.main = 'plugin.js';
writeFileSync(join(staging, 'dist', 'openclaw.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
```

Verify via `scripts/verify-tarball.mjs` — add a `dist/openclaw.plugin.json` existence check.

## Files

- `scripts/build-tarball.mjs:49-56` (tarball staging)
- `scripts/verify-tarball.mjs` (add assertion)
- `scripts/copy-extension-entry.js` (reference implementation — deploy.sh calls this)
- `scripts/deploy.sh:87-95` (the equivalent behavior on dev deploys)

## Done when

- v1.14.2 (or later) tarball contains `dist/openclaw.plugin.json` with `main: "plugin.js"`
- Fresh installer run (no prior `npm run deploy`) produces a working plugin load — `[AOF] Plugin loaded` appears in gateway.log on first gateway start
- verify-tarball.mjs fails if dist/openclaw.plugin.json is missing
