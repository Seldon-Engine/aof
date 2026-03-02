# Phase 6: Installer - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

A single `curl -fsSL <url>/install.sh | sh` command that installs AOF on a machine with Node >= 22, scaffolds a full workspace, and wires AOF as an OpenClaw plugin. Running it again upgrades without data loss. The installer downloads release tarballs from the real GitHub repository (created by Phase 5 CI).

</domain>

<decisions>
## Implementation Decisions

### Wizard flow
- Fully automatic — zero interactive prompts, pipe-friendly
- Default install location: `~/.aof`
- CLI arg to override install location (e.g. `install.sh --prefix /custom/path`)
- Full workspace scaffolding on fresh install: AOF code, config, plus empty directories for tasks, events, memory, and an org chart template
- Terminal output: show each step with progress indicators (checking Node... done, downloading... done), then a summary with "what to do next" instructions

### Upgrade behavior
- Detection strategy: smart detection that handles both legacy installs (users who followed the current deployment guide) and future installs (directory + version file check)
- Must provide clean upgrade path for existing AOF users who installed manually
- Migration pipeline: versioned migrations that can modify tasks/events/memory/config structure when needed
- Auto-backup before any upgrade — backup data before running migrations
- Auto-run migrations without prompts (consistent with fully-automatic philosophy)
- Auto-rollback from backup if any migration fails — user returns to pre-upgrade state
- Long-term: version file (`~/.aof/.version` or similar) as the canonical version indicator

### Prerequisite checks & errors
- Check: Node >= 22, OpenClaw presence, git, curl/wget, disk space, write permissions on install dir
- On missing prerequisite: print exactly what's missing, how to install it, and exit cleanly — never modify the system
- OpenClaw is a **soft requirement**: install AOF even without OpenClaw, skip plugin wiring, warn that it won't work until a platform connector is installed (supports future platform decoupling)
- On partial failure (e.g. download succeeds but scaffolding fails): clean up everything — remove anything the installer created, leave the machine as if it never ran

### Plugin wiring
- OpenClaw discovery: expose CLI arg for explicit path (validated), otherwise run comprehensive heuristic (known paths including historical ones, env vars like OPENCLAW_HOME)
- If OpenClaw config not found: prompt or abort (Claude's discretion)
- Config modification: use `openclaw config set/get` CLI commands where possible (avoid direct file editing)
- If AOF entry already exists: update it
- If AOF entry doesn't exist: add it and **disable any other active memory plugin** (only one memory plugin can be active at a time)
- Post-wiring: run a health check to verify AOF plugin loaded and responds
- If health check fails: roll back the plugin wiring (undo config change), keep AOF files installed — user can re-run or manually wire later

### Claude's Discretion
- Exact health check implementation
- Heuristic fallback behavior when OpenClaw config not found (prompt vs abort)
- Migration file format and naming convention
- Backup location and naming scheme
- How to detect legacy (pre-installer) AOF installations
- Exact prerequisite check ordering and messages

</decisions>

<specifics>
## Specific Ideas

- Design for platform decoupling: `~/.aof` as independent home dir (not nested under `~/.openclaw`) so AOF can support other platforms in the future
- Memory plugin exclusivity: when first installing AOF as a memory plugin, must disable other memory plugins — there's an existing mechanism for importing memory data from other plugins (proof of concept) that should be enhanced in a future roadmap item
- Existing AOF users who followed the current deployment guide need a clean upgrade path — can't assume version files exist on first upgrade

</specifics>

<deferred>
## Deferred Ideas

- Enhanced memory data import from other memory plugins (current mechanism is proof of concept)
- Support for additional platform connectors beyond OpenClaw

</deferred>

---

*Phase: 06-installer*
*Context gathered: 2026-02-26*
