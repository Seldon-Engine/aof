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

INSTALL_DIR=""
VERSION="latest"
OPENCLAW_PATH=""
CHANNEL="stable"
IS_UPGRADE=""
EXISTING_VERSION=""
LEGACY_INSTALL=""
DOWNLOAD_CMD=""
CLEANUP_PATHS=""
TARBALL=""
FRESH_INSTALL=""

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
      --help|-h)
        printf "AOF Installer\n\n"
        printf "Usage: install.sh [OPTIONS]\n\n"
        printf "Options:\n"
        printf "  --prefix <path>         Install directory (default: ~/.aof)\n"
        printf "  --version <ver>         Specific version (default: latest)\n"
        printf "  --openclaw-path <path>  Explicit OpenClaw config path\n"
        printf "  --channel <ch>          Release channel: stable/beta (default: stable)\n"
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

  # Default install directory
  if [ -z "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/.aof"
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

extract_and_install() {
  printf "\nInstalling...\n"

  if [ -n "$IS_UPGRADE" ]; then
    # Backup data directories before upgrade
    BACKUP_DIR="$INSTALL_DIR/.aof-backup/backup-$(date +%s)"
    mkdir -p "$BACKUP_DIR"

    for dir in tasks events memory state data logs Projects; do
      if [ -d "$INSTALL_DIR/$dir" ]; then
        cp -R "$INSTALL_DIR/$dir" "$BACKUP_DIR/$dir"
      fi
    done

    # Also backup individual data files
    for f in memory.db memory-hnsw.dat .version org/org-chart.yaml; do
      if [ -f "$INSTALL_DIR/$f" ]; then
        mkdir -p "$BACKUP_DIR/$(dirname "$f")"
        cp "$INSTALL_DIR/$f" "$BACKUP_DIR/$f"
      fi
    done

    say "Data backed up to ${BACKUP_DIR}"
  else
    # Fresh install: create directory
    mkdir -p "$INSTALL_DIR"
    add_cleanup "$INSTALL_DIR"
  fi

  # Extract tarball (contents are at root level, no wrapper directory)
  tar -xzf "$TARBALL" -C "$INSTALL_DIR" || {
    err "Failed to extract tarball"
    if [ -n "$IS_UPGRADE" ] && [ -n "$BACKUP_DIR" ]; then
      warn "Restoring from backup..."
      for dir in tasks events memory state data logs Projects; do
        if [ -d "$BACKUP_DIR/$dir" ]; then
          rm -rf "$INSTALL_DIR/$dir"
          cp -R "$BACKUP_DIR/$dir" "$INSTALL_DIR/$dir"
        fi
      done
      for f in memory.db memory-hnsw.dat .version org/org-chart.yaml; do
        if [ -f "$BACKUP_DIR/$f" ]; then
          mkdir -p "$INSTALL_DIR/$(dirname "$f")"
          cp "$BACKUP_DIR/$f" "$INSTALL_DIR/$f"
        fi
      done
      say "Backup restored"
    fi
    exit 1
  }
  say "Extracted to ${INSTALL_DIR}"

  # Install production dependencies
  if [ -f "$INSTALL_DIR/package-lock.json" ]; then
    (cd "$INSTALL_DIR" && npm ci --production --loglevel=error) || {
      err "npm ci failed"
      exit 1
    }
  else
    (cd "$INSTALL_DIR" && npm install --production --loglevel=error) || {
      err "npm install failed"
      exit 1
    }
  fi
  say "Dependencies installed"

  # If upgrade: restore data directories (tarball may have overwritten them)
  if [ -n "$IS_UPGRADE" ] && [ -n "$BACKUP_DIR" ]; then
    for dir in tasks events memory state data logs Projects; do
      if [ -d "$BACKUP_DIR/$dir" ]; then
        rm -rf "$INSTALL_DIR/$dir"
        cp -R "$BACKUP_DIR/$dir" "$INSTALL_DIR/$dir"
      fi
    done
    for f in memory.db memory-hnsw.dat org/org-chart.yaml; do
      if [ -f "$BACKUP_DIR/$f" ]; then
        mkdir -p "$INSTALL_DIR/$(dirname "$f")"
        cp "$BACKUP_DIR/$f" "$INSTALL_DIR/$f"
      fi
    done
    say "User data restored from backup"
  fi

  # Remove install dir from cleanup on success (only clean on fresh install failure)
  if [ -z "$IS_UPGRADE" ]; then
    # Remove INSTALL_DIR from CLEANUP_PATHS since extraction succeeded
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
    node "$INSTALL_DIR/dist/cli/index.js" setup --auto \
      --data-dir "$INSTALL_DIR" \
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

install_daemon() {
  if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
    say "Installing daemon service..."
    if node "$INSTALL_DIR/dist/cli/index.js" daemon install \
      --data-dir "$INSTALL_DIR" 2>&1; then
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

  # Check binary works
  if ! node "$INSTALL_DIR/dist/cli/index.js" --version >/dev/null 2>&1; then
    warn "aof binary check failed"
    ok=false
  fi

  # Check org chart exists
  if [ ! -f "$INSTALL_DIR/org/org-chart.yaml" ]; then
    warn "org chart missing after install"
    ok=false
  fi

  # Check tasks dir exists
  if [ ! -d "$INSTALL_DIR/tasks/ready" ]; then
    warn "tasks directory structure missing"
    ok=false
  fi

  if [ "$ok" = false ]; then
    warn "Install validation failed — run 'aof setup --auto --data-dir $INSTALL_DIR' to repair"
  else
    say "Install validated"
  fi
}

# --- Print summary ---

print_summary() {
  printf "\n"
  printf "  \033[1;32mAOF v%s installed successfully!\033[0m\n" "$VERSION"
  printf "\n"
  printf "  Location: %s\n" "$INSTALL_DIR"

  if [ -n "$IS_UPGRADE" ] && [ -n "$EXISTING_VERSION" ]; then
    printf "  Upgraded from v%s to v%s\n" "$EXISTING_VERSION" "$VERSION"
  fi

  # Check OpenClaw status
  if command -v openclaw >/dev/null 2>&1; then
    printf "  OpenClaw plugin: configured\n"
  else
    printf "  OpenClaw: not detected (install OpenClaw to use AOF as a platform plugin)\n"
  fi

  if [ -n "$DAEMON_INSTALLED" ]; then
    printf "  Daemon: installed and running\n"
  else
    printf "  Daemon: not installed — run 'aof daemon install' to start\n"
  fi

  printf "\n"
  printf "  Next steps:\n"
  printf "    1. Restart your shell (or run: source your shell profile)\n"
  printf "    2. Review your org chart: %s/org/org-chart.yaml\n" "$INSTALL_DIR"
  if [ -z "$DAEMON_INSTALLED" ]; then
    printf "    3. Start the daemon:      aof daemon install\n"
    printf "    4. Create your first task: aof task create \"My first task\"\n"
  else
    printf "    3. Create your first task: aof task create \"My first task\"\n"
  fi
  printf "\n"
}

# --- Main ---

main() {
  printf "\033[1mAOF Installer\033[0m\n"

  parse_args "$@"
  check_prerequisites
  detect_existing_install
  determine_version
  download_tarball
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
