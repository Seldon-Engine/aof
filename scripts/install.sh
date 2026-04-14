#!/bin/sh
# AOF Installer — curl -fsSL <url>/install.sh | sh
#
# Downloads and installs Agentic Ops Fabric.
# All logic wrapped in main() to prevent partial-download execution.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/d0labs/aof/main/scripts/install.sh | sh
#   sh install.sh --prefix /custom/path --version 1.0.0
#
set -eu

# --- Output helpers ---

say() {
  printf "  \033[32m✓\033[0m %s\n" "$1"
}

warn() {
  printf "  \033[33m!\033[0m %s\n" "$1"
}

err() {
  printf "  \033[31m✗\033[0m %s\n" "$1" >&2
}

# --- Globals ---

INSTALL_DIR=""      # Code location (default: ~/.aof). Wiped on --clean.
DATA_DIR=""         # User data location (default: ~/.aof-data). Never wiped.
VERSION="latest"
OPENCLAW_PATH=""
CHANNEL="stable"
IS_UPGRADE=""
EXISTING_VERSION=""
LEGACY_INSTALL=""
LEGACY_DATA_IN_INSTALL_DIR=""  # Set when pre-v1.13 install has data mixed with code
DOWNLOAD_CMD=""
CLEANUP_PATHS=""
TARBALL=""
FRESH_INSTALL=""
CLEAN_INSTALL=""
ASSUME_YES=""
FORCE_CLEAN=""
LOCAL_TARBALL=""
BACKUP_DIR=""
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

# --- Trap-based cleanup ---

cleanup() {
  if [ -n "$CLEANUP_PATHS" ]; then
    # shellcheck disable=SC2086
    for p in $CLEANUP_PATHS; do
      if [ -e "$p" ]; then
        rm -rf "$p"
      fi
    done
  fi
  # Always resume services we paused — even on abort/error — so the user's
  # gateway is never left down by a partial install. resume_live_writers is
  # a no-op if PAUSED_SERVICES is empty.
  [ -n "${PAUSED_SERVICES:-}" ] && resume_live_writers 2>/dev/null || true
}

trap cleanup EXIT

add_cleanup() {
  if [ -z "$CLEANUP_PATHS" ]; then
    CLEANUP_PATHS="$1"
  else
    CLEANUP_PATHS="$CLEANUP_PATHS $1"
  fi
}

# --- Argument parsing ---

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --prefix)
        shift
        INSTALL_DIR="$1"
        ;;
      --data-dir)
        shift
        DATA_DIR="$1"
        ;;
      --version)
        shift
        VERSION="$1"
        ;;
      --openclaw-path)
        shift
        OPENCLAW_PATH="$1"
        ;;
      --channel)
        shift
        CHANNEL="$1"
        ;;
      --clean)
        CLEAN_INSTALL="true"
        ;;
      --yes|-y)
        ASSUME_YES="true"
        ;;
      --force)
        FORCE_CLEAN="true"
        ;;
      --tarball)
        # Skip the GitHub download and use a pre-built tarball instead.
        # Primarily a local-testing hook — lets us exercise install.sh
        # against unreleased code (e.g. regression fixes waiting on a tag).
        shift
        LOCAL_TARBALL="$1"
        ;;
      --help|-h)
        printf "AOF Installer\n\n"
        printf "Usage: install.sh [OPTIONS]\n\n"
        printf "Options:\n"
        printf "  --prefix <path>         Install (code) directory (default: ~/.aof)\n"
        printf "  --data-dir <path>       User-data directory (default: ~/.aof-data).\n"
        printf "                          Kept separate from --prefix so code can be\n"
        printf "                          wiped and reinstalled without risking data.\n"
        printf "  --version <ver>         Specific version (default: latest)\n"
        printf "  --openclaw-path <path>  Explicit OpenClaw config path\n"
        printf "  --channel <ch>          Release channel: stable/beta (default: stable)\n"
        printf "  --clean                 Wipe install directory + OpenClaw integration\n"
        printf "                          points, perform fresh install. User data at\n"
        printf "                          --data-dir is not touched.\n"
        printf "  --yes, -y               Skip confirmation prompts (requires --clean)\n"
        printf "  --force                 Proceed with --clean even if openclaw-gateway\n"
        printf "                          appears to be running.\n"
        printf "  --tarball <path>        Install from a local tarball instead of\n"
        printf "                          downloading from GitHub. Intended for testing\n"
        printf "                          unreleased builds.\n"
        printf "  -h, --help              Show this help\n"
        exit 0
        ;;
      *)
        err "Unknown option: $1"
        exit 1
        ;;
    esac
    shift
  done

  # Default install directory (code)
  if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/.aof"
  fi

  # Default data directory — by convention a dedicated subdirectory of the
  # install root. The installer knows to preserve this subdirectory across
  # upgrades and --clean; everything else under $INSTALL_DIR is wiped.
  if [ -z "$DATA_DIR" ]; then
    DATA_DIR="$INSTALL_DIR/data"
  fi

  # Refuse the obviously-broken case where DATA_DIR equals INSTALL_DIR —
  # that collapses the segregation we rely on for clean upgrades.
  if [ "$(cd "$INSTALL_DIR" 2>/dev/null && pwd)" = "$(cd "$DATA_DIR" 2>/dev/null && pwd)" ] \
     && [ "$INSTALL_DIR" = "$DATA_DIR" ]; then
    err "--data-dir must not equal --prefix ($INSTALL_DIR)."
    printf "    User data needs a dedicated subdirectory so code can be wiped safely.\n"
    exit 1
  fi
}

# --- Prerequisite checks ---

check_prerequisites() {
  printf "\nChecking prerequisites...\n"

  # Node.js >= 22
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is not installed."
    printf "    Install Node.js >= 22: https://nodejs.org/\n"
    exit 1
  fi

  NODE_VERSION=$(node --version | sed 's/^v//')
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    err "Node.js >= 22 required (found v${NODE_VERSION})."
    printf "    Install Node.js >= 22: https://nodejs.org/\n"
    exit 1
  fi
  say "Node.js v${NODE_VERSION}"

  # tar
  if ! command -v tar >/dev/null 2>&1; then
    err "tar is not installed."
    printf "    Install tar via your package manager (apt, brew, etc.)\n"
    exit 1
  fi
  say "tar"

  # curl or wget
  if command -v curl >/dev/null 2>&1; then
    DOWNLOAD_CMD="curl"
    say "curl"
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOAD_CMD="wget"
    say "wget"
  else
    err "curl or wget is required."
    printf "    Install curl or wget via your package manager\n"
    exit 1
  fi

  # git (soft check)
  if command -v git >/dev/null 2>&1; then
    say "git"
  else
    warn "git not found. Some features may be limited."
  fi

  # Write permissions on parent directory
  PARENT_DIR=$(dirname "$INSTALL_DIR")
  if [ ! -w "$PARENT_DIR" ]; then
    err "No write permission on ${PARENT_DIR}"
    printf "    Run with sudo or choose a different --prefix\n"
    exit 1
  fi
  say "Write permissions on ${PARENT_DIR}"

  # Disk space (soft check)
  if command -v df >/dev/null 2>&1; then
    AVAIL_KB=$(df -k "$PARENT_DIR" 2>/dev/null | tail -1 | awk '{print $4}')
    if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 512000 ] 2>/dev/null; then
      warn "Low disk space: $(( AVAIL_KB / 1024 ))MB available (recommend >= 500MB)"
    fi
  fi
}

# --- Detect existing installation ---

detect_existing_install() {
  printf "\nDetecting existing installation...\n"

  # Modern install: .version file
  if [ -f "$INSTALL_DIR/.version" ]; then
    EXISTING_VERSION=$(cat "$INSTALL_DIR/.version")
    IS_UPGRADE="true"
    say "Existing installation detected (v${EXISTING_VERSION})"

    # Pre-v1.13 had data mixed with code in $INSTALL_DIR. Detect by checking
    # for any data directory at the install root. Migration 006 (run via
    # 'aof setup') will relocate it to $DATA_DIR — we just flag it here so
    # install.sh knows to preserve that data through the install cycle.
    for d in tasks events memory state Projects org; do
      if [ -d "$INSTALL_DIR/$d" ]; then
        LEGACY_DATA_IN_INSTALL_DIR="true"
        say "Legacy mixed-layout data detected in $INSTALL_DIR — will be migrated to $DATA_DIR"
        break
      fi
    done
    return
  fi

  # Legacy: ~/.openclaw/aof/package.json
  if [ -f "$HOME/.openclaw/aof/package.json" ]; then
    LEGACY_INSTALL="true"
    IS_UPGRADE="true"
    say "Legacy installation detected at ~/.openclaw/aof/"
    return
  fi

  # Legacy: ~/.openclaw/extensions/aof/
  if [ -d "$HOME/.openclaw/extensions/aof" ]; then
    LEGACY_INSTALL="true"
    IS_UPGRADE="true"
    say "Legacy installation detected at ~/.openclaw/extensions/aof/"
    return
  fi

  say "Fresh installation"
  FRESH_INSTALL="true"
}

# --- Determine version ---

determine_version() {
  if [ "$VERSION" != "latest" ]; then
    say "Target version: v${VERSION}"
    return
  fi

  printf "\nResolving latest version...\n"

  RELEASE_URL="https://api.github.com/repos/d0labs/aof/releases/latest"

  if [ "$DOWNLOAD_CMD" = "curl" ]; then
    RELEASE_JSON=$(curl -fsSL "$RELEASE_URL" 2>/dev/null) || {
      err "Failed to fetch latest release info"
      exit 1
    }
  else
    RELEASE_JSON=$(wget -qO- "$RELEASE_URL" 2>/dev/null) || {
      err "Failed to fetch latest release info"
      exit 1
    }
  fi

  # Parse tag_name without jq
  TAG=$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$TAG" ]; then
    err "Could not parse version from GitHub release"
    exit 1
  fi

  VERSION=$(printf '%s' "$TAG" | sed 's/^v//')
  say "Latest version: v${VERSION}"
}

# --- Download tarball ---

download_tarball() {
  # --tarball bypass: use the provided file verbatim, skip network entirely.
  # We don't register it for cleanup — the caller owns that file.
  if [ -n "$LOCAL_TARBALL" ]; then
    if [ ! -f "$LOCAL_TARBALL" ]; then
      err "--tarball path not found: $LOCAL_TARBALL"
      exit 1
    fi
    TARBALL="$LOCAL_TARBALL"
    say "Using local tarball: $TARBALL"
    return 0
  fi

  printf "\nDownloading AOF v%s...\n" "$VERSION"

  TARBALL_TMP=$(mktemp "${TMPDIR:-/tmp}/aof-install.XXXXXX")
  TARBALL="${TARBALL_TMP}.tar.gz"
  mv "$TARBALL_TMP" "$TARBALL"
  add_cleanup "$TARBALL"

  DOWNLOAD_URL="https://github.com/d0labs/aof/releases/download/v${VERSION}/aof-v${VERSION}.tar.gz"

  if [ "$DOWNLOAD_CMD" = "curl" ]; then
    curl -fsSL -o "$TARBALL" "$DOWNLOAD_URL" || {
      err "Failed to download AOF v${VERSION}"
      printf "    URL: %s\n" "$DOWNLOAD_URL"
      exit 1
    }
  else
    wget -q -O "$TARBALL" "$DOWNLOAD_URL" || {
      err "Failed to download AOF v${VERSION}"
      printf "    URL: %s\n" "$DOWNLOAD_URL"
      exit 1
    }
  fi

  say "Downloaded aof-v${VERSION}.tar.gz"
}

# --- Extract and install ---
#
# Under the single-roof layout, code and user data both live under $INSTALL_DIR
# but user data is confined to $DATA_DIR (defaults to $INSTALL_DIR/data). We
# preserve data across the upgrade by moving it OUT to a sibling backup dir,
# wiping $INSTALL_DIR, extracting the fresh tarball, then moving data back in.
#
# This gives us atomic, non-zombie upgrades without needing a per-version code
# manifest: whatever was in $INSTALL_DIR before the upgrade is gone after.
#
# The backup dir lives outside $INSTALL_DIR so a wipe cannot destroy it.

# --- Live-writer management ----------------------------------------------
#
# Upgrading while services are writing to $DATA_DIR creates a race: the
# preserve→wipe→extract→restore cycle moves data out, but any live writer
# (the gateway's in-process AOF plugin and/or the ai.openclaw.aof daemon)
# keeps creating files under the now-moved path. The wipe then fails with
# "Directory not empty" and the install aborts mid-flight.
#
# Fix: detect running launchd services that write to $DATA_DIR, boot them
# out before preserve_data_dir, and restart at the end. We remember which
# we paused so we only restart what we stopped.
PAUSED_SERVICES=""

service_is_loaded() {
  launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
}

pause_live_writers() {
  # Only meaningful on macOS launchd. No-op elsewhere.
  command -v launchctl >/dev/null 2>&1 || return 0

  # Candidates: both may write to $DATA_DIR via the shared AOFService.
  for svc in ai.openclaw.gateway ai.openclaw.aof; do
    if service_is_loaded "$svc"; then
      launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
      # Wait up to 5s for the process to actually exit.
      i=0
      while service_is_loaded "$svc" && [ "$i" -lt 10 ]; do
        sleep 0.5
        i=$((i + 1))
      done
      # Force-kill any stragglers. Name the command (not the plist label).
      case "$svc" in
        ai.openclaw.gateway)
          pkill -9 -f "openclaw-gateway" 2>/dev/null || true
          ;;
        ai.openclaw.aof)
          pkill -9 -f "aof-daemon" 2>/dev/null || true
          ;;
      esac
      PAUSED_SERVICES="$PAUSED_SERVICES $svc"
      say "Paused service: $svc (will restart after install)"
    fi
  done
}

resume_live_writers() {
  [ -z "$PAUSED_SERVICES" ] && return 0
  for svc in $PAUSED_SERVICES; do
    plist="$HOME/Library/LaunchAgents/$svc.plist"
    if [ -f "$plist" ]; then
      # launchctl bootstrap returns EIO if the service is already loaded
      # (e.g. re-bootstrapped by the OS between pause and resume). Guard
      # with an explicit load check to keep resume idempotent.
      if ! service_is_loaded "$svc"; then
        launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
      fi
      # -k kicks a running service; also works as plain start if stopped.
      launchctl kickstart -k "gui/$(id -u)/$svc" 2>/dev/null || true
      say "Resumed service: $svc"
    fi
  done
  PAUSED_SERVICES=""
}

# Move $DATA_DIR temporarily to the external backup path. Sets PRESERVED_DATA.
PRESERVED_DATA=""
preserve_data_dir() {
  if [ ! -d "$DATA_DIR" ]; then
    return 0
  fi

  if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$HOME/.aof-backup-$(date +%Y%m%d-%H%M%S)"
  fi
  mkdir -p "$BACKUP_DIR"
  PRESERVED_DATA="$BACKUP_DIR/data"

  if [ -e "$PRESERVED_DATA" ]; then
    err "Backup destination already exists: $PRESERVED_DATA"
    exit 1
  fi

  mv "$DATA_DIR" "$PRESERVED_DATA" || {
    err "Could not preserve user data to $PRESERVED_DATA"
    exit 1
  }
  say "User data preserved: $DATA_DIR → $PRESERVED_DATA"
}

# Move PRESERVED_DATA back into $DATA_DIR. Called after the fresh extract.
restore_preserved_data() {
  if [ -z "$PRESERVED_DATA" ] || [ ! -d "$PRESERVED_DATA" ]; then
    return 0
  fi

  # Tarball's skills/prompts/dist don't touch the data subdir, but the fresh
  # extract creates $INSTALL_DIR so $DATA_DIR's parent exists. If something
  # left a stale $DATA_DIR in place (shouldn't happen — we moved it), remove.
  rm -rf "$DATA_DIR"
  mkdir -p "$(dirname "$DATA_DIR")"
  mv "$PRESERVED_DATA" "$DATA_DIR" || {
    err "Failed to restore user data from $PRESERVED_DATA"
    err "Your data is safe at: $PRESERVED_DATA"
    exit 1
  }
  say "User data restored to $DATA_DIR"
}

# Wipe $INSTALL_DIR except for what $DATA_DIR is under.
# Precondition: data has already been moved out by preserve_data_dir.
wipe_code_in_install_dir() {
  if [ ! -d "$INSTALL_DIR" ]; then
    return 0
  fi
  rm -rf "$INSTALL_DIR" || {
    err "Failed to remove $INSTALL_DIR"
    err "User data (if any was preserved) remains at: $PRESERVED_DATA"
    exit 1
  }
}

extract_and_install() {
  printf "\nInstalling...\n"

  if [ -n "$IS_UPGRADE" ] || [ -n "$CLEAN_INSTALL" ]; then
    # Stop any live writer (gateway plugin + standalone daemon) before we
    # move/wipe $DATA_DIR and $INSTALL_DIR; otherwise the scheduler keeps
    # recreating directories under the moved path and rm -rf fails.
    pause_live_writers
    # Move user data out of the way, then wipe the install dir so the fresh
    # extract starts from a clean slate. No code zombies survive.
    preserve_data_dir
    wipe_code_in_install_dir
  fi

  mkdir -p "$INSTALL_DIR"
  if [ -z "$IS_UPGRADE" ] && [ -z "$CLEAN_INSTALL" ]; then
    # Fresh install: register cleanup trap in case extraction fails midway
    add_cleanup "$INSTALL_DIR"
  fi

  # Extract tarball (contents are at root level, no wrapper directory)
  tar -xzf "$TARBALL" -C "$INSTALL_DIR" || {
    err "Failed to extract tarball"
    if [ -n "$PRESERVED_DATA" ]; then
      err "Your data is safe at: $PRESERVED_DATA"
      err "Restore it manually with: mv '$PRESERVED_DATA' '$DATA_DIR'"
    fi
    exit 1
  }
  say "Extracted to ${INSTALL_DIR}"

  # Install production dependencies
  if [ -f "$INSTALL_DIR/package-lock.json" ]; then
    (cd "$INSTALL_DIR" && npm ci --production --loglevel=error) || {
      err "npm ci failed"
      if [ -n "$PRESERVED_DATA" ]; then
        err "Your data is safe at: $PRESERVED_DATA"
      fi
      exit 1
    }
  else
    (cd "$INSTALL_DIR" && npm install --production --loglevel=error) || {
      err "npm install failed"
      if [ -n "$PRESERVED_DATA" ]; then
        err "Your data is safe at: $PRESERVED_DATA"
      fi
      exit 1
    }
  fi
  say "Dependencies installed"

  # Restore user data into the fresh install
  restore_preserved_data

  # Restart any services we paused. Safe no-op if nothing was paused.
  resume_live_writers

  # Remove install dir from cleanup on success (only clean on fresh install failure)
  if [ -z "$IS_UPGRADE" ] && [ -z "$CLEAN_INSTALL" ]; then
    NEW_CLEANUP=""
    for p in $CLEANUP_PATHS; do
      if [ "$p" != "$INSTALL_DIR" ]; then
        if [ -z "$NEW_CLEANUP" ]; then
          NEW_CLEANUP="$p"
        else
          NEW_CLEANUP="$NEW_CLEANUP $p"
        fi
      fi
    done
    CLEANUP_PATHS="$NEW_CLEANUP"
  fi
}

# --- Run Node.js setup ---

run_node_setup() {
  printf "\nRunning setup...\n"

  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    # Pass DATA_DIR (not INSTALL_DIR). Migration 006 reads this to know the
    # destination when moving data out of the legacy mixed layout.
    node "$INSTALL_DIR/dist/cli/index.js" setup --auto \
      --data-dir "$DATA_DIR" \
      ${IS_UPGRADE:+--upgrade} \
      ${LEGACY_INSTALL:+--legacy} \
      ${OPENCLAW_PATH:+--openclaw-path "$OPENCLAW_PATH"} \
      2>&1 || {
      warn "Setup completed with warnings (non-fatal)"
    }
  else
    warn "dist/cli/index.js not found -- skipping Node.js setup"
    warn "Run 'aof setup --auto' manually after building"
  fi
}

# --- Write version file ---

write_version_file() {
  printf '%s' "$VERSION" > "$INSTALL_DIR/.version"
  say "Version file written"
}

# --- Setup shell PATH ---

setup_shell_path() {
  local bin_dir="$INSTALL_DIR/bin"
  mkdir -p "$bin_dir"

  # Create aof launcher script
  cat > "$bin_dir/aof" <<LAUNCHER
#!/bin/sh
exec node "$INSTALL_DIR/dist/cli/index.js" "\$@"
LAUNCHER
  chmod +x "$bin_dir/aof"

  # Create aof-daemon launcher script
  cat > "$bin_dir/aof-daemon" <<LAUNCHER
#!/bin/sh
exec node "$INSTALL_DIR/dist/daemon/index.js" "\$@"
LAUNCHER
  chmod +x "$bin_dir/aof-daemon"

  say "Launcher scripts created in $bin_dir"

  # Add bin_dir to PATH in shell profile (idempotent via sentinel comment)
  local sentinel="# AOF PATH"
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/sh}")"

  case "$shell_name" in
    fish)
      local fish_config="${HOME}/.config/fish/config.fish"
      if [ -f "$fish_config" ] && grep -q "$sentinel" "$fish_config" 2>/dev/null; then
        say "PATH already configured in $fish_config"
      else
        mkdir -p "$(dirname "$fish_config")"
        printf '\n%s\nfish_add_path "%s"\n' "$sentinel" "$bin_dir" >> "$fish_config"
        say "PATH added to $fish_config"
      fi
      ;;
    zsh)
      local zshrc="${HOME}/.zshrc"
      if [ -f "$zshrc" ] && grep -q "$sentinel" "$zshrc" 2>/dev/null; then
        say "PATH already configured in $zshrc"
      else
        printf '\n%s\nexport PATH="%s:$PATH"\n' "$sentinel" "$bin_dir" >> "$zshrc"
        say "PATH added to $zshrc"
      fi
      ;;
    *)
      local bashrc="${HOME}/.bashrc"
      if [ -f "${HOME}/.bash_profile" ] && ! [ -f "$bashrc" ]; then
        bashrc="${HOME}/.bash_profile"
      fi
      if [ -f "$bashrc" ] && grep -q "$sentinel" "$bashrc" 2>/dev/null; then
        say "PATH already configured in $bashrc"
      else
        printf '\n%s\nexport PATH="%s:$PATH"\n' "$sentinel" "$bin_dir" >> "$bashrc"
        say "PATH added to $bashrc"
      fi
      ;;
  esac
}

# --- Install daemon ---

DAEMON_INSTALLED=""

# plugin_mode_detected — returns 0 if OpenClaw plugin integration is present.
# Detection signal (D-01): $OPENCLAW_HOME/extensions/aof exists as a symlink
# OR a directory. The symlink is created by scripts/deploy.sh; a directory
# indicates a legacy hand-copy install and also counts.
# Zero-dep, no CLI call, no config read, safe to call multiple times.
plugin_mode_detected() {
  ext_link="$OPENCLAW_HOME/extensions/aof"
  if [ -L "$ext_link" ] || [ -d "$ext_link" ]; then
    return 0
  fi
  return 1
}

install_daemon() {
  # Mode-exclusivity gate (Phase 42, D-03).
  # When plugin-mode is detected, skip the standalone daemon install.
  # Plan 03 adds --force-daemon override; Plan 04 adds D-05 upgrade convergence.
  if plugin_mode_detected; then
    say "Plugin-mode detected — skipping standalone daemon. Scheduler runs in-process via openclaw gateway."
    return 0
  fi

  # Existing install path — unchanged from pre-Phase 42.
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    if node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$DATA_DIR" 2>&1; then
      DAEMON_INSTALLED="true"
      say "Daemon installed and running"
    else
      warn "Daemon install failed (non-fatal) — run 'aof daemon install' manually"
    fi
  fi
}

# --- Validate install ---

validate_install() {
  local ok=true

  # Check binary works (code lives in INSTALL_DIR)
  if ! node "$INSTALL_DIR/dist/cli/index.js" --version >/dev/null 2>&1; then
    warn "aof binary check failed"
    ok=false
  fi

  # Check scaffold exists (data lives in DATA_DIR)
  if [ ! -f "$DATA_DIR/org/org-chart.yaml" ]; then
    warn "org chart missing in $DATA_DIR"
    ok=false
  fi

  if [ ! -d "$DATA_DIR/tasks/ready" ]; then
    warn "tasks directory structure missing in $DATA_DIR"
    ok=false
  fi

  if [ "$ok" = false ]; then
    warn "Install validation failed — run 'aof setup --auto --data-dir $DATA_DIR' to repair"
  else
    say "Install validated"
  fi
}

# --- Print summary ---

print_summary() {
  printf "\n"
  printf "  \033[1;32mAOF v%s installed successfully!\033[0m\n" "$VERSION"
  printf "\n"
  printf "  Code:      %s\n" "$INSTALL_DIR"
  printf "  User data: %s\n" "$DATA_DIR"

  if [ -n "$IS_UPGRADE" ] && [ -n "$EXISTING_VERSION" ]; then
    printf "  Upgraded from v%s to v%s\n" "$EXISTING_VERSION" "$VERSION"
  fi

  if [ -n "$LEGACY_DATA_IN_INSTALL_DIR" ]; then
    printf "  Legacy data migrated from %s → %s\n" "$INSTALL_DIR" "$DATA_DIR"
  fi

  # Check OpenClaw status
  if command -v openclaw >/dev/null 2>&1; then
    printf "  OpenClaw plugin: configured\n"
  else
    printf "  OpenClaw: not detected (install OpenClaw to use AOF as a platform plugin)\n"
  fi

  if plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: skipped (scheduler runs via OpenClaw plugin)\n"
  elif [ -n "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: installed and running\n"
  else
    printf "  Daemon: not installed — run 'aof daemon install' to start\n"
  fi

  if [ -n "$CLEAN_INSTALL" ] && [ -n "$BACKUP_DIR" ]; then
    printf "  Backup: %s (retained — delete when satisfied)\n" "$BACKUP_DIR"
  fi

  printf "\n"
  printf "  Next steps:\n"
  printf "    1. Restart your shell (or run: source your shell profile)\n"
  printf "    2. Review your org chart: %s/org/org-chart.yaml\n" "$DATA_DIR"
  if plugin_mode_detected && [ -z "$DAEMON_INSTALLED" ]; then
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  elif [ -z "$DAEMON_INSTALLED" ]; then
    printf "    3. Start the daemon:      aof daemon install\n"
    printf "    4. Create your first task: aof task create \"My first task\"\n"
  else
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  fi
  printf "\n"
}

# ============================================================================
# --clean flow: unwire integration points, then let normal install take over
# ============================================================================
#
# Under the single-roof layout, extract_and_install already preserves user data
# (via preserve_data_dir → wipe → restore_preserved_data) on every upgrade.
# --clean only needs to do the EXTRA things a normal upgrade doesn't:
#
#   1. Refuse if openclaw-gateway is live (gateway holds AOF code in memory).
#   2. Prompt for confirmation (skippable with --yes).
#   3. Remove external integration points AOF owns but doesn't live under
#      $INSTALL_DIR: plugin symlinks, companion skill dir, openclaw.json entries.
#
# User data preservation and install dir wipe happen downstream in the shared
# extract_and_install path — the CLEAN_INSTALL flag triggers them there.
# ============================================================================

# Detect whether openclaw-gateway is running. Clean install against a live
# gateway is unsafe — gateway holds AOF code in memory and config in memory.
# Returns 0 if gateway appears to be running.
detect_running_gateway() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "openclaw-gateway" >/dev/null 2>&1 && return 0
    pgrep -f "openclaw gateway" >/dev/null 2>&1 && return 0
  fi
  if command -v ps >/dev/null 2>&1; then
    ps -A -o comm= 2>/dev/null | grep -q "openclaw-gateway" && return 0
  fi
  return 1
}

# Interactive confirmation. Bypassed by --yes.
confirm_clean() {
  if [ -n "$ASSUME_YES" ]; then
    return 0
  fi

  printf "\n"
  printf "  \033[1;33m⚠  Clean install will:\033[0m\n"
  printf "    • Preserve user data at %s (moved aside during install)\n" "$DATA_DIR"
  printf "    • Wipe everything else under %s\n" "$INSTALL_DIR"
  printf "    • Remove OpenClaw plugin symlinks and companion skill\n"
  printf "    • Unregister AOF from %s/openclaw.json\n" "$OPENCLAW_HOME"
  printf "    • Install a fresh copy of AOF v%s\n" "$VERSION"
  printf "    • Restore user data into the fresh install\n"
  printf "\n"
  printf "  Proceed? [y/N] "

  # Read from /dev/tty so this works under `curl ... | sh`
  local reply=""
  if [ -r /dev/tty ]; then
    read -r reply < /dev/tty
  else
    warn "No TTY available; pass --yes to proceed non-interactively."
    return 1
  fi

  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Path for the current clean-install backup. Computed once, reused.
clean_backup_path() {
  if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$HOME/.aof-backup-$(date +%Y%m%d-%H%M%S)"
  fi
  printf '%s' "$BACKUP_DIR"
}

# Remove an openclaw.json config path entry. Uses node for structured JSON
# editing — safer than sed on nested JSON. No-op if node or config absent.
unwire_openclaw_config() {
  local config="$OPENCLAW_HOME/openclaw.json"

  if [ ! -f "$config" ]; then
    say "No OpenClaw config found; skipping unregistration."
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    warn "node unavailable — cannot unregister AOF from $config"
    warn "Manually remove entries: plugins.entries.aof, plugins.slots.memory, plugins.allow[aof], plugins.load.paths entries under $INSTALL_DIR"
    return 0
  fi

  # Backup config before modifying
  local config_backup="$config.pre-clean-$(date +%s)"
  cp "$config" "$config_backup" || {
    warn "Could not back up $config — aborting openclaw unregistration"
    return 0
  }

  INSTALL_DIR="$INSTALL_DIR" node - "$config" <<'NODE'
const fs = require('fs');
const path = require('path');
const configPath = process.argv[2];
const installDir = process.env.INSTALL_DIR;

const AOF_TOOLS = [
  'aof_task_complete', 'aof_task_update', 'aof_task_block', 'aof_status_report'
];

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  console.error(`Failed to parse ${configPath}: ${e.message}`);
  process.exit(1);
}

let changed = false;

// 1. plugins.entries.aof
if (config.plugins?.entries?.aof) {
  delete config.plugins.entries.aof;
  changed = true;
}

// 2. plugins.allow — remove "aof"
if (Array.isArray(config.plugins?.allow)) {
  const before = config.plugins.allow.length;
  config.plugins.allow = config.plugins.allow.filter(x => x !== 'aof');
  if (config.plugins.allow.length !== before) changed = true;
}

// 3. plugins.slots.memory — clear if pointing at aof
if (config.plugins?.slots?.memory === 'aof') {
  delete config.plugins.slots.memory;
  changed = true;
}

// 4. plugins.load.paths — drop entries pointing at our install dir
if (Array.isArray(config.plugins?.load?.paths)) {
  const before = config.plugins.load.paths.length;
  config.plugins.load.paths = config.plugins.load.paths.filter(p =>
    p !== installDir &&
    !p.startsWith(installDir + path.sep) &&
    !p.endsWith('/.aof') &&
    !p.endsWith('/aof')
  );
  if (config.plugins.load.paths.length !== before) changed = true;
}

// 5. tools.alsoAllow — drop AOF tool names
if (Array.isArray(config.tools?.alsoAllow)) {
  const before = config.tools.alsoAllow.length;
  config.tools.alsoAllow = config.tools.alsoAllow.filter(t => !AOF_TOOLS.includes(t));
  if (config.tools.alsoAllow.length !== before) changed = true;
}

if (changed) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('AOF entries removed from openclaw.json');
} else {
  console.log('No AOF entries found in openclaw.json');
}
NODE

  say "OpenClaw config unregistered (backup: $config_backup)"
}

# Remove integration points AOF owns outside $INSTALL_DIR — plugin symlinks,
# the companion skill, and openclaw.json config entries. The install dir
# itself is handled by extract_and_install (preserve_data_dir + wipe + extract).
remove_external_integration() {
  printf "\nRemoving OpenClaw integration points...\n"

  # Current plugin symlink
  local ext_link="$OPENCLAW_HOME/extensions/aof"
  if [ -L "$ext_link" ] || [ -e "$ext_link" ]; then
    rm -rf "$ext_link" || warn "Could not remove $ext_link"
    say "Removed $ext_link"
  fi

  # Orphan predecessor symlink — only remove if it's actually a symlink; a
  # real directory here would indicate a split-brain install worth inspecting.
  local plugin_link="$OPENCLAW_HOME/plugins/aof"
  if [ -L "$plugin_link" ]; then
    rm -f "$plugin_link" || warn "Could not remove $plugin_link"
    say "Removed orphan symlink $plugin_link"
  elif [ -d "$plugin_link" ]; then
    warn "$plugin_link exists as a directory (not a symlink); leaving untouched — investigate manually"
  fi

  # Companion skill — rewritten by 'aof setup' during the fresh install
  local skill_dir="$OPENCLAW_HOME/skills/aof"
  if [ -d "$skill_dir" ]; then
    rm -rf "$skill_dir" || warn "Could not remove $skill_dir"
    say "Removed $skill_dir"
  fi

  unwire_openclaw_config
}

# Orchestrator for --clean. Only handles pre-install gating + external cleanup;
# data preservation and install-dir wipe happen in extract_and_install.
run_clean_flow_preinstall() {
  if detect_running_gateway && [ -z "$FORCE_CLEAN" ]; then
    err "openclaw-gateway appears to be running."
    printf "    Clean install is unsafe while the gateway holds AOF code in memory.\n"
    printf "    Shut the gateway down first, or re-run with --force (not recommended).\n"
    exit 1
  fi

  if ! confirm_clean; then
    printf "\n  Aborted by user.\n\n"
    exit 0
  fi

  remove_external_integration

  FRESH_INSTALL="true"
  IS_UPGRADE=""
  LEGACY_INSTALL=""
}

# ============================================================================
# --- Main ---
# ============================================================================

main() {
  printf "\033[1mAOF Installer\033[0m\n"

  parse_args "$@"
  check_prerequisites
  detect_existing_install
  determine_version
  download_tarball

  if [ -n "$CLEAN_INSTALL" ]; then
    run_clean_flow_preinstall
  fi

  extract_and_install
  run_node_setup
  write_version_file
  setup_shell_path
  install_daemon
  validate_install
  print_summary

  # Clear cleanup paths on success (don't remove tarball temp since it's harmless)
  CLEANUP_PATHS=""
}

main "$@"
