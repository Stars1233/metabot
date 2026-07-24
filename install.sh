#!/usr/bin/env bash
# MetaBot Installer
# Usage:
#   git clone https://github.com/xvirobotics/metabot.git ~/metabot
#   cd ~/metabot && bash install.sh
#   # Optional: METABOT_HOME=/opt/metabot bash install.sh
set -euo pipefail

# ============================================================================
# CRITICAL: When running via `curl | bash`, stdin is the pipe (not terminal).
# All interactive reads MUST use /dev/tty explicitly.
# ============================================================================
if [[ ! -t 0 ]] && [[ -e /dev/tty ]]; then
  TTY=/dev/tty
else
  TTY=/dev/stdin
fi

# ============================================================================
# Parse CLI arguments
# ============================================================================
INSTALL_DIR_ARG=""
print_usage() {
  cat <<'USAGE'
MetaBot Installer

Usage:
  bash install.sh [OPTIONS]
  curl -fsSL <url> | bash -s -- [OPTIONS]

Options:
  -d, --dir <path>     Install MetaBot to <path>.
                       Priority: --dir > METABOT_HOME env var > interactive prompt.
                       Default: $HOME/metabot
  -h, --help           Show this help and exit.

Examples:
  bash install.sh
  bash install.sh --dir /opt/metabot
  bash install.sh -d ~/projects/metabot
  METABOT_HOME=/opt/metabot bash install.sh
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires a path argument" >&2; exit 1; }
      INSTALL_DIR_ARG="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR_ARG="${1#--dir=}"
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Warning: unknown argument '$1'" >&2
      shift
      ;;
  esac
done

# ============================================================================
# Configuration defaults
# ============================================================================
# METABOT_HOME is resolved later (Phase 0.5) — priority: --dir > env var > prompt > default.
DEFAULT_METABOT_HOME="$HOME/metabot"
METABOT_REPO="${METABOT_REPO:-https://github.com/xvirobotics/metabot.git}"

# ============================================================================
# Colors and formatting
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║            MetaBot Installer             ║"
  echo "  ║        一生二，二生三，三生万物          ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${NC}"
  echo ""
}

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}==> $*${NC}"; }

metabot_backup_existing_skill() {
  local source="$1"
  local backup_root="$2"
  [[ -e "$source" || -L "$source" ]] || return 0
  mkdir -p "$backup_root"
  local backup
  backup="$(mktemp -d "$backup_root/$(basename "$source").XXXXXX")"
  rmdir "$backup"
  mv "$source" "$backup"
}

metabot_install_skill_bundle() {
  local source="$1"
  local destination="$2"
  local backup_root="$3"
  if [[ -d "$destination" ]] && diff -qr "$source" "$destination" >/dev/null 2>&1; then
    return 0
  fi
  metabot_backup_existing_skill "$destination" "$backup_root"
  mkdir -p "$destination"
  cp -R "$source/." "$destination/"
}

# Safe prompt — reads from /dev/tty, uses printf -v (no eval)
prompt_input() {
  local varname="$1"
  local prompt_text="$2"
  local default_val="${3:-}"
  local input

  if [[ -n "$default_val" ]]; then
    echo -en "${CYAN}  $prompt_text${NC} [${default_val}]: " >&2
  else
    echo -en "${CYAN}  $prompt_text${NC}: " >&2
  fi
  read -r input < "$TTY" || input=""
  if [[ -z "$input" ]]; then
    input="$default_val"
  fi
  printf -v "$varname" '%s' "$input"
}

prompt_secret() {
  local varname="$1"
  local prompt_text="$2"
  local input

  echo -en "${CYAN}  $prompt_text${NC}: " >&2
  read -rs input < "$TTY" || input=""
  echo "" >&2
  printf -v "$varname" '%s' "$input"
}

prompt_choice() {
  local varname="$1"
  local default_val="$2"
  local input

  echo -en "${CYAN}  Choice${NC} [${default_val}]: " >&2
  read -r input < "$TTY" || input=""
  if [[ -z "$input" ]]; then
    input="$default_val"
  fi
  printf -v "$varname" '%s' "$input"
}

prompt_yn() {
  local prompt_text="$1"
  local default="${2:-y}"
  local input

  if [[ "$default" == "y" ]]; then
    echo -en "${CYAN}  $prompt_text${NC} [Y/n]: " >&2
  else
    echo -en "${CYAN}  $prompt_text${NC} [y/N]: " >&2
  fi
  read -r input < "$TTY" || input=""
  input="${input:-$default}"
  # Use tr for bash 3.x compatibility (macOS ships bash 3.2)
  local lower
  lower="$(printf '%s' "$input" | tr '[:upper:]' '[:lower:]')"
  [[ "$lower" == "y" || "$lower" == "yes" ]]
}

# ============================================================================
# Phase 0: Banner + detect OS/arch
# ============================================================================
banner

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: ${OS} ${ARCH}"

if [[ "$OS" != "Linux" && "$OS" != "Darwin" ]]; then
  error "Unsupported OS: $OS. MetaBot supports Linux and macOS."
  exit 1
fi

# Portable sed -i helper
sed_i() {
  if [[ "$OS" == "Darwin" ]]; then
    sed -i "" "$@"
  else
    sed -i "$@"
  fi
}

# ============================================================================
# Phase 0.5: Resolve install directory
# Priority: --dir CLI arg > METABOT_HOME env var > interactive prompt > default.
# ============================================================================
step "Phase 0.5: Choose install directory"

if [[ -n "$INSTALL_DIR_ARG" ]]; then
  METABOT_HOME="$INSTALL_DIR_ARG"
  info "Using install directory from --dir: $METABOT_HOME"
elif [[ -n "${METABOT_HOME:-}" ]]; then
  info "Using install directory from METABOT_HOME env: $METABOT_HOME"
else
  echo ""
  echo -e "${BOLD}Where should MetaBot be installed?${NC}"
  echo "  (You can override later with the METABOT_HOME env var or --dir flag.)"
  prompt_input METABOT_HOME "Install directory" "$DEFAULT_METABOT_HOME"
fi

# Expand a leading ~ to $HOME (avoids eval; safe with spaces).
METABOT_HOME="${METABOT_HOME/#\~/$HOME}"

# Require an absolute path so all later $METABOT_HOME references are unambiguous.
if [[ "$METABOT_HOME" != /* ]]; then
  error "Install path must be absolute, got: $METABOT_HOME"
  exit 1
fi

# Refuse a few obviously-bad targets that would clobber the user's home or root.
case "$METABOT_HOME" in
  /|/root|/home|/Users|"$HOME")
    error "Refusing to install directly into $METABOT_HOME — pick a dedicated subdirectory."
    exit 1
    ;;
esac

success "Install directory: $METABOT_HOME"

# ============================================================================
# Phase 1: Check prerequisites
# ============================================================================
step "Phase 1: Checking prerequisites"

check_command() {
  local cmd="$1"
  local name="${2:-$1}"
  local install_hint="${3:-}"
  if command -v "$cmd" &>/dev/null; then
    success "$name found: $(command -v "$cmd")"
    return 0
  else
    error "$name not found."
    if [[ -n "$install_hint" ]]; then
      echo "  Install: $install_hint"
    fi
    return 1
  fi
}

MISSING=0
check_command git "Git" "https://git-scm.com/downloads" || MISSING=1

version_at_least() {
  local current="${1#v}"
  local required="${2#v}"
  local current_major current_minor current_patch
  local required_major required_minor required_patch

  current="$(printf '%s' "$current" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*$/\1/')"
  required="$(printf '%s' "$required" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+).*$/\1/')"
  [[ "$current" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [[ "$required" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1

  IFS=. read -r current_major current_minor current_patch <<< "$current"
  IFS=. read -r required_major required_minor required_patch <<< "$required"
  (( current_major > required_major )) ||
    (( current_major == required_major && current_minor > required_minor )) ||
    (( current_major == required_major && current_minor == required_minor && current_patch >= required_patch ))
}

MIN_NODE_VERSION="22.19.0"

install_node() {
  info "Installing Node.js 22.x via NodeSource..."
  if [[ "$OS" == "Linux" ]]; then
    if command -v apt-get &>/dev/null; then
      # Debian/Ubuntu
      curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n apt-get install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    elif command -v dnf &>/dev/null; then
      # Fedora/RHEL
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n dnf install -y nodejs 2>/dev/null || sudo dnf install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    elif command -v yum &>/dev/null; then
      # CentOS/older RHEL
      curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
      sudo -n bash /tmp/nodesource_setup.sh 2>/dev/null || sudo bash /tmp/nodesource_setup.sh
      sudo -n yum install -y nodejs 2>/dev/null || sudo yum install -y nodejs
      rm -f /tmp/nodesource_setup.sh
    else
      return 1
    fi
  elif [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install node@22
    else
      return 1
    fi
  fi
  # Verify
  if command -v node &>/dev/null && version_at_least "$(node --version)" "$MIN_NODE_VERSION"; then
    success "Node.js installed: $(node --version)"
    return 0
  fi
  return 1
}

NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_VER="$(node --version | sed 's/v//')"
  if version_at_least "$NODE_VER" "$MIN_NODE_VERSION"; then
    success "Node.js found: v${NODE_VER}"
  else
    warn "Node.js v${NODE_VER} found, but v${MIN_NODE_VERSION}+ is required."
    NEED_NODE=true
  fi
else
  warn "Node.js not found."
  NEED_NODE=true
fi

if [[ "$NEED_NODE" == "true" ]]; then
  if prompt_yn "Install Node.js 22.x automatically?"; then
    if install_node; then
      success "Node.js ready"
    else
      error "Automatic install failed. Please install Node.js ${MIN_NODE_VERSION}+ manually:"
      echo "  https://nodejs.org/ or use nvm/fnm"
      MISSING=1
    fi
  else
    error "Node.js ${MIN_NODE_VERSION}+ is required. Install manually and re-run."
    exit 1
  fi
fi

check_command npm "npm" "Comes with Node.js" || MISSING=1

if [[ "$MISSING" -eq 1 ]]; then
  error "Please install missing prerequisites and re-run this script."
  exit 1
fi

# ============================================================================
# Phase 2: Clone or update repo
# ============================================================================
step "Phase 2: Setting up MetaBot at ${METABOT_HOME}"

if [[ "${METABOT_SKIP_GIT:-0}" == "1" ]]; then
  # Set by the metabot-core bootstrap (packages/server/install/bootstrap.sh),
  # which downloads + extracts the bot-host tarball into $METABOT_HOME before
  # exec'ing this script. The git clone/pull phase is unnecessary in that
  # mode (no remote — refresh model is to re-run the bootstrap). The Phase 6
  # SKILL_SENTINEL check still catches a corrupt/incomplete extraction.
  info "Pre-staged from tarball (METABOT_SKIP_GIT=1), skipping git phase."
  cd "$METABOT_HOME"
elif [[ -d "$METABOT_HOME/.git" ]]; then
  info "Existing installation found, pulling latest..."
  cd "$METABOT_HOME"
  OLD_HEAD="$(git rev-parse HEAD)"
  if ! git pull --ff-only; then
    error "git pull --ff-only failed at $METABOT_HOME."
    error "Your checkout has diverged from origin or has uncommitted changes."
    error "Continuing with stale code would silently break later phases (e.g. Phase 6 'skill not found')."
    error ""
    error "Fix one of these and re-run install.sh:"
    error "  - Inspect:        cd $METABOT_HOME && git status && git log --oneline -5"
    error "  - Stash & retry:  cd $METABOT_HOME && git stash && git pull --ff-only"
    error "  - Reset to origin (DESTROYS local commits/edits):"
    error "      cd $METABOT_HOME && git fetch origin && git reset --hard origin/main"
    exit 1
  fi
  NEW_HEAD="$(git rev-parse HEAD)"
  # Re-exec with the updated install.sh if it changed (avoids running stale code from memory)
  if [[ "$OLD_HEAD" != "$NEW_HEAD" && -z "${METABOT_REEXEC:-}" ]]; then
    info "install.sh updated, re-launching..."
    export METABOT_REEXEC=1
    exec bash "$METABOT_HOME/install.sh"
  fi
else
  info "Cloning MetaBot..."
  git clone "$METABOT_REPO" "$METABOT_HOME"
  cd "$METABOT_HOME"
fi
success "MetaBot code ready at ${METABOT_HOME}"

# GitHub Releases ship the complete self-hosted personal edition. Private or
# legacy bridge packages retain the smaller four-workspace layout.
PERSONAL_EDITION_PACKAGE=false
PACKAGE_MANIFEST="$METABOT_HOME/.metabot-package/manifest.json"
if node -e '
  const fs = require("node:fs");
  const [manifestPath, packagePath] = process.argv.slice(1);
  let personal;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    personal = manifest.package === "metabot-personal-edition" && manifest.includesCore === true;
  } else {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    personal = pkg.metabotEdition === "personal";
  }
  process.exit(personal ? 0 : 1);
' "$PACKAGE_MANIFEST" "$METABOT_HOME/package.json"; then
  PERSONAL_EDITION_PACKAGE=true
  success "Personal edition package detected (Bridge + Core + Web UI)"
fi

# ============================================================================
# Phase 3: Install dependencies
# ============================================================================
step "Phase 3: Installing dependencies"

cd "$METABOT_HOME"
# Private bridge hosts only need:
#   - root bridge runtime + devDeps (tsx for PM2, tsc for build, vitest)
#   - @xvirobotics/cli + cli-core + metamemory + skill-hub (the four thin CLI
#     workspaces — @xvirobotics/cli depends on the other three)
# The Core workspaces — @xvirobotics/metabot-core-server (better-sqlite3) and
# @xvirobotics/metabot-core-web-ui (React/Vite) — are included for the public
# personal edition and excluded only from the legacy/private bridge flavor.
if [[ "$PERSONAL_EDITION_PACKAGE" == "true" ]]; then
  info "Running npm install for the complete personal edition..."
  npm install --include=dev
  success "npm dependencies installed (Bridge + Core + Web UI)"
else
  info "Running npm install (bridge runtime + CLI workspaces; server/web-ui excluded)..."
  npm install --include=dev \
    --workspace=@xvirobotics/cli \
    --workspace=@xvirobotics/cli-core \
    --workspace=@xvirobotics/metamemory \
    --workspace=@xvirobotics/skill-hub \
    --include-workspace-root
  success "npm dependencies installed (CLI workspaces, no server/web-ui)"
fi

# Helper: npm install -g with sudo fallback
npm_install_global() {
  npm install -g "$@" 2>/dev/null || sudo -n npm install -g "$@" 2>/dev/null || sudo npm install -g "$@"
}

codex_config_has_features_table() {
  local config="$1"
  [[ -f "$config" ]] && grep -Eq '^[[:space:]]*\[features\][[:space:]]*$' "$config"
}

codex_config_feature_is_set() {
  local config="$1"
  local key="$2"
  [[ -f "$config" ]] || return 1
  awk -v key="$key" '
    /^[[:space:]]*\[features\][[:space:]]*$/ { in_features=1; next }
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ { in_features=0 }
    in_features && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { found=1 }
    END { exit(found ? 0 : 1) }
  ' "$config"
}

codex_config_set_feature_default() {
  local config="$1"
  local key="$2"
  local value="$3"

  if codex_config_feature_is_set "$config" "$key"; then
    return 0
  fi

  if ! codex_config_has_features_table "$config"; then
    {
      echo ""
      echo "[features]"
      echo "${key} = ${value}"
    } >> "$config"
    return 0
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    /^[[:space:]]*\[features\][[:space:]]*$/ {
      in_features=1
      print
      next
    }
    in_features && /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      if (!inserted) {
        print key " = " value
        inserted=1
      }
      in_features=0
    }
    { print }
    END {
      if (in_features && !inserted) {
        print key " = " value
      }
    }
  ' "$config" > "$tmp"
  mv "$tmp" "$config"
}

ensure_codex_agent_defaults() {
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local config="$codex_home/config.toml"
  mkdir -p "$codex_home/skills" "$codex_home/memories" "$codex_home/agents"
  touch "$config"
  chmod 600 "$config" 2>/dev/null || true

  codex_config_set_feature_default "$config" "multi_agent" "true"
  codex_config_set_feature_default "$config" "memories" "true"
  codex_config_set_feature_default "$config" "guardian_approval" "true"
  codex_config_set_feature_default "$config" "prevent_idle_sleep" "true"

  success "Codex agent defaults ensured in $config (multi_agent, memories, guardian_approval, prevent_idle_sleep)"
}

if ! command -v pm2 &>/dev/null; then
  info "Installing PM2 globally..."
  npm_install_global pm2
  success "PM2 installed"
else
  success "PM2 already installed"
fi

# Claude and Kimi CLI installs are driven by the engine choice in Phase 4.
# We still ensure the Claude CLI is present as a default convenience, since
# most users start with Claude and may mix engines later.
if command -v claude &>/dev/null; then
  success "Claude CLI found: $(command -v claude)"
else
  info "Installing Claude CLI..."
  npm_install_global @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    success "Claude CLI installed"
  else
    warn "Claude CLI install failed. Install manually: sudo npm install -g @anthropic-ai/claude-code"
  fi
fi

# Install the current Kimi Code CLI. MetaBot's Kimi adapter requires the 0.27+
# local Server API; the retired Python kimi-cli `--wire` surface is incompatible.
kimi_code_version() {
  local output
  output="$(kimi --version 2>/dev/null | head -1 || true)"
  printf '%s' "$output" | sed -nE 's/^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p'
}

install_kimi_cli() {
  if command -v kimi &>/dev/null; then
    local installed_version
    installed_version="$(kimi_code_version)"
    if [[ -n "$installed_version" ]] && version_at_least "$installed_version" "0.27.0"; then
      success "Kimi Code found: $(command -v kimi) (v${installed_version})"
      return 0
    fi
    warn "Kimi CLI at $(command -v kimi) is older than 0.27.0 or has an unreadable version; upgrading."
  fi

  info "Installing Kimi Code 0.27+ from npm..."
  mkdir -p "$HOME/.local"
  if npm install -g --prefix "$HOME/.local" @moonshot-ai/kimi-code@latest 2>&1 | tail -3; then
    export PATH="$HOME/.local/bin:$PATH"
    hash -r
    local installed_version=""
    if command -v kimi &>/dev/null; then
      installed_version="$(kimi_code_version)"
    fi
    if [[ -n "$installed_version" ]] && version_at_least "$installed_version" "0.27.0"; then
      success "Kimi Code installed: $(command -v kimi) (v${installed_version})"
      return 0
    fi
  fi
  warn "Kimi Code 0.27+ install verification failed. Install manually: npm install -g @moonshot-ai/kimi-code@latest"
  return 1
}

# Build and start the local personal Core before interactive configuration so
# a fresh install can securely wire its one-time token into the bridge config.
PERSONAL_LOCAL_CORE=false
start_personal_core() {
  local configured_url=""
  local token_from_env_file=""
  local health_ok=false
  local data_dir="$HOME/.metabot-core/data"
  local token_file="$HOME/.metabot-core/token"
  local bootstrap_token_file="$data_dir/admin-bootstrap-token.txt"

  if [[ -f "$METABOT_HOME/.env" ]]; then
    configured_url="$(sed -n 's/^[[:space:]]*METABOT_CORE_URL=//p' "$METABOT_HOME/.env" | tail -1 | tr -d '\r')"
    token_from_env_file="$(sed -n 's/^[[:space:]]*METABOT_CORE_TOKEN=//p' "$METABOT_HOME/.env" | tail -1 | tr -d '\r')"
  fi
  configured_url="${METABOT_CORE_URL:-$configured_url}"

  if [[ "${METABOT_INSTALL_CORE:-1}" == "0" ]]; then
    info "METABOT_INSTALL_CORE=0 — keeping external Core configuration"
    return 0
  fi
  case "$configured_url" in
    ""|http://localhost:9200|http://127.0.0.1:9200) ;;
    *)
      info "Existing external metabot-core preserved: $configured_url"
      return 0
      ;;
  esac

  PERSONAL_LOCAL_CORE=true
  export METABOT_CORE_URL="${configured_url:-http://localhost:9200}"
  mkdir -p "$data_dir" "$HOME/.metabot-core/logs"
  chmod 700 "$HOME/.metabot-core" "$data_dir" 2>/dev/null || true

  info "Building local metabot-core server..."
  npm run build -w @xvirobotics/metabot-core-server
  info "Building local token-authenticated Web UI..."
  npm run build -w @xvirobotics/metabot-core-web-ui

  if pm2 describe metabot-core &>/dev/null 2>&1; then
    local existing_core_cwd=""
    existing_core_cwd="$(pm2 jlist 2>/dev/null | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const proc = JSON.parse(raw).find((entry) => entry.name === "metabot-core");
          process.stdout.write(proc?.pm2_env?.pm_cwd || "");
        } catch { process.exit(2); }
      });
    ')"
    if [[ -z "$existing_core_cwd" || "$existing_core_cwd" != "$METABOT_HOME" ]]; then
      error "Refusing to replace an existing metabot-core owned by another installation."
      error "Existing cwd: ${existing_core_cwd:-unknown}; requested cwd: $METABOT_HOME"
      exit 1
    fi
    info "Removing old metabot-core PM2 process..."
    pm2 delete metabot-core 2>/dev/null || true
  fi
  info "Starting local metabot-core on http://localhost:9200..."
  METABOT_CORE_DATA_DIR="$data_dir" pm2 start ecosystem.core.config.cjs --only metabot-core

  for _ in $(seq 1 30); do
    if node -e "fetch('http://127.0.0.1:9200/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
      health_ok=true
      break
    fi
    sleep 1
  done
  if [[ "$health_ok" != "true" ]]; then
    error "Local metabot-core did not become healthy on port 9200."
    error "Inspect: pm2 logs metabot-core --lines 50"
    exit 1
  fi

  if [[ -n "${METABOT_CORE_TOKEN:-}" ]]; then
    : # Explicit caller configuration wins.
  elif [[ -n "$token_from_env_file" ]]; then
    export METABOT_CORE_TOKEN="$token_from_env_file"
  elif [[ -s "$token_file" ]]; then
    METABOT_CORE_TOKEN="$(head -n 1 "$token_file" | tr -d '\r\n')"
    export METABOT_CORE_TOKEN
  elif [[ -s "$bootstrap_token_file" ]]; then
    mkdir -p "$(dirname "$token_file")"
    cp "$bootstrap_token_file" "$token_file"
    chmod 600 "$token_file"
    METABOT_CORE_TOKEN="$(head -n 1 "$token_file" | tr -d '\r\n')"
    export METABOT_CORE_TOKEN
    success "Local Core token saved to $token_file (mode 600)"
  else
    error "Local metabot-core is healthy but no usable token file was found."
    exit 1
  fi

  if ! METABOT_CORE_TOKEN="$METABOT_CORE_TOKEN" node -e '
    const token = process.env.METABOT_CORE_TOKEN;
    Promise.all([
      fetch("http://127.0.0.1:9200/api/agents", { headers: { Authorization: `Bearer ${token}` } }),
      fetch("http://127.0.0.1:9200/"),
    ]).then(async ([api, ui]) => {
      const html = await ui.text();
      process.exit(api.ok && ui.ok && /<html/i.test(html) ? 0 : 1);
    }).catch(() => process.exit(1));
  '; then
    error "Local Core failed its authenticated API or Web UI smoke check."
    exit 1
  fi

  if [[ -f "$METABOT_HOME/.env" && -z "$token_from_env_file" ]]; then
    printf '\n# Local personal-edition Core token (also stored in ~/.metabot-core/token)\nMETABOT_CORE_TOKEN=%s\n' \
      "$METABOT_CORE_TOKEN" >> "$METABOT_HOME/.env"
    chmod 600 "$METABOT_HOME/.env"
  fi

  success "Local metabot-core is healthy; Web UI: http://localhost:9200"
}

if [[ "$PERSONAL_EDITION_PACKAGE" == "true" ]]; then
  start_personal_core
fi

# ============================================================================
# Phase 4: Interactive configuration
# ============================================================================
step "Phase 4: Configuration"

if [[ -f "$METABOT_HOME/.env" ]]; then
  warn ".env already exists. Skipping interactive config."
  warn "Edit ${METABOT_HOME}/.env to modify settings."
  SKIP_CONFIG=true
else
  SKIP_CONFIG=false
fi

if [[ "$SKIP_CONFIG" == "false" ]]; then

  # ------ 4a: Working directory ------
  echo ""
  echo -e "${BOLD}Working Directory:${NC}"
  prompt_input WORK_DIR "Project directory for the Agent to work in" "$HOME/metabot-workspace"
  mkdir -p "$WORK_DIR"
  success "Working directory: ${WORK_DIR}"

  # ------ 4b: Engine selection ------
  echo ""
  echo -e "${BOLD}Agent Engine:${NC}"
  echo "  1) Codex CLI (OpenAI — requires codex login, uses your ChatGPT subscription)"
  echo "  2) Kimi Code (Moonshot AI — requires kimi login, uses your subscription; default model kimi-code/k3)"
  echo "  3) Claude Code compatibility (Anthropic)"
  prompt_choice ENGINE_CHOICE "1"

  BOT_ENGINE="codex"
  CLAUDE_AUTH_ENV_LINES=""
  CLAUDE_AUTH_METHOD="codex"

  if [[ "$ENGINE_CHOICE" == "2" ]]; then
    BOT_ENGINE="kimi"
    CLAUDE_AUTH_METHOD="kimi"
    echo ""
    info "Installing Kimi Code..."
    install_kimi_cli || warn "Continuing despite Kimi Code install failure — you can install it later."
    info "After install, run 'kimi login' in a separate terminal to authenticate."
    # Skip the Claude provider prompt entirely for Kimi — it has its own auth.
    AUTH_CHOICE="kimi"
  elif [[ "$ENGINE_CHOICE" == "1" ]]; then
    BOT_ENGINE="codex"
    CLAUDE_AUTH_METHOD="codex"
    echo ""
    if command -v codex &>/dev/null; then
      success "Codex CLI found: $(command -v codex)"
    else
      info "Installing Codex CLI..."
      npm_install_global @openai/codex
      if command -v codex &>/dev/null; then
        success "Codex CLI installed: $(command -v codex)"
      else
        warn "Codex CLI install failed. Install manually: sudo npm install -g @openai/codex"
        warn "MetaBot will still be configured — install Codex + run 'codex login' before starting."
      fi
    fi
    ensure_codex_agent_defaults
    info "After install, run 'codex login' in a separate terminal to authenticate (or set OPENAI_API_KEY / configure a profile in ~/.codex/config.toml)."
    info "Codex memories and multi-agent defaults are enabled in ~/.codex/config.toml; use 'codex features list' to inspect."
    info "Note: Codex runs with approvalPolicy='never' and sandbox='workspace-write' by default — interactive tool approvals are not surfaced to IM."
    # Skip the Claude provider prompt entirely for Codex — it has its own auth.
    AUTH_CHOICE="codex"
  else
    # ------ 4b-claude: Claude AI authentication ------
    echo ""
    echo -e "${BOLD}Claude AI Authentication:${NC}"
    echo "  1) Claude Code Subscription (OAuth — run 'claude login' after install)"
    echo "  2) Anthropic API Key (sk-ant-...)"
    echo "  3) Third-party provider (Kimi/Moonshot, DeepSeek, GLM, etc.)"
    prompt_choice AUTH_CHOICE "1"
  fi

  case "$AUTH_CHOICE" in
    kimi|codex)
      : # handled above
      ;;
    1)
      CLAUDE_AUTH_METHOD="subscription"
      info "Using Claude Code Subscription. Run 'claude login' after install."
      ;;
    2)
      CLAUDE_AUTH_METHOD="anthropic_key"
      prompt_secret ANTHROPIC_API_KEY "Anthropic API Key (sk-ant-...)"
      if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        error "API key is required."; exit 1
      fi
      CLAUDE_AUTH_ENV_LINES="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
      ;;
    3)
      CLAUDE_AUTH_METHOD="third_party"
      echo ""
      echo -e "  ${BOLD}Select provider:${NC}"
      echo "    1) Kimi/Moonshot  (https://platform.moonshot.cn)"
      echo "    2) DeepSeek       (https://platform.deepseek.com)"
      echo "    3) GLM/Zhipu      (https://open.bigmodel.cn)"
      echo "    4) Custom URL"
      prompt_choice PROVIDER_CHOICE "1"

      case "$PROVIDER_CHOICE" in
        1) PROVIDER_NAME="Kimi/Moonshot"; PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        2) PROVIDER_NAME="DeepSeek"; PROVIDER_BASE_URL="https://api.deepseek.com/anthropic"
           PROVIDER_DEFAULT_MODEL="deepseek-chat"; PROVIDER_DEFAULT_SMALL_MODEL="deepseek-chat" ;;
        3) PROVIDER_NAME="GLM/Zhipu"; PROVIDER_BASE_URL="https://api.z.ai/api/anthropic"
           PROVIDER_DEFAULT_MODEL="glm-4.5"; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        4) PROVIDER_NAME="Custom"
           prompt_input PROVIDER_BASE_URL "API Base URL (e.g. https://api.example.com/anthropic)"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
        *) PROVIDER_NAME="Kimi/Moonshot"; PROVIDER_BASE_URL="https://api.moonshot.ai/anthropic"
           PROVIDER_DEFAULT_MODEL=""; PROVIDER_DEFAULT_SMALL_MODEL="" ;;
      esac

      info "Provider: ${PROVIDER_NAME} (${PROVIDER_BASE_URL})"
      prompt_secret PROVIDER_API_KEY "${PROVIDER_NAME} API Key"
      if [[ -z "$PROVIDER_API_KEY" ]]; then
        error "API key is required."; exit 1
      fi

      prompt_input PROVIDER_MODEL "Model name (enter for default)" "${PROVIDER_DEFAULT_MODEL}"
      prompt_input PROVIDER_SMALL_MODEL "Small/fast model (enter to skip)" "${PROVIDER_DEFAULT_SMALL_MODEL}"

      CLAUDE_AUTH_ENV_LINES="# ${PROVIDER_NAME} Provider
ANTHROPIC_BASE_URL=${PROVIDER_BASE_URL}
ANTHROPIC_AUTH_TOKEN=${PROVIDER_API_KEY}"
      [[ -n "$PROVIDER_MODEL" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_MODEL=${PROVIDER_MODEL}"
      [[ -n "$PROVIDER_SMALL_MODEL" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
ANTHROPIC_SMALL_FAST_MODEL=${PROVIDER_SMALL_MODEL}"
      [[ "$PROVIDER_CHOICE" == "2" ]] && CLAUDE_AUTH_ENV_LINES="${CLAUDE_AUTH_ENV_LINES}
API_TIMEOUT_MS=600000"
      ;;
  esac

  # ------ 4c: IM Bot platform + credentials ------
  echo ""
  echo -e "${BOLD}IM Bot Platform:${NC}"
  echo "  1) Feishu/Lark"
  echo "  2) Telegram"
  echo "  3) WeChat ClawBot"
  echo "  4) Feishu + Telegram"
  echo "  5) Feishu + WeChat"
  echo "  6) All"
  prompt_choice PLATFORM_CHOICE "1"

  SETUP_FEISHU=false
  SETUP_TELEGRAM=false
  SETUP_WECHAT=false
  case "$PLATFORM_CHOICE" in
    1) SETUP_FEISHU=true ;;
    2) SETUP_TELEGRAM=true ;;
    3) SETUP_WECHAT=true ;;
    4) SETUP_FEISHU=true; SETUP_TELEGRAM=true ;;
    5) SETUP_FEISHU=true; SETUP_WECHAT=true ;;
    6) SETUP_FEISHU=true; SETUP_TELEGRAM=true; SETUP_WECHAT=true ;;
    *) SETUP_FEISHU=true ;;
  esac

  FEISHU_APP_ID=""
  FEISHU_APP_SECRET=""
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}Feishu/Lark Credentials:${NC}"
    prompt_input FEISHU_APP_ID "App ID (e.g. cli_xxxx)"
    prompt_secret FEISHU_APP_SECRET "App Secret"
    if [[ -z "$FEISHU_APP_ID" || -z "$FEISHU_APP_SECRET" ]]; then
      error "Feishu App ID and Secret are required."; exit 1
    fi
  fi

  TELEGRAM_BOT_TOKEN=""
  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}Telegram Credentials:${NC}"
    prompt_secret TELEGRAM_BOT_TOKEN "Bot Token (from @BotFather)"
    if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
      error "Telegram Bot Token is required."; exit 1
    fi
  fi

  if [[ "$SETUP_WECHAT" == "true" ]]; then
    echo ""
    echo -e "  ${BOLD}WeChat ClawBot:${NC}"
    info "No credentials needed — you'll scan a QR code after installation."
    info "Requires WeChat ClawBot beta access (apply at ilinkai.weixin.qq.com)."
  fi

  # ------ 4d: Bot name + auto-generated settings ------
  echo ""
  echo -e "${BOLD}Bot Name:${NC}"
  prompt_input BOT_NAME "Name for your bot" "metabot"

  # Auto-generate API secret
  API_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)"
  API_PORT="9100"
  LOG_LEVEL="info"

  # Claude executable path
  CLAUDE_PATH=""
  if command -v claude &>/dev/null; then
    CLAUDE_PATH="$(command -v claude)"
  fi

  # ------ 4e: self-hosted metabot-core service ------
  echo ""
  echo -e "${BOLD}self-hosted metabot-core service:${NC}"
  if [[ "$PERSONAL_LOCAL_CORE" == "true" ]]; then
    METABOT_CORE_URL="${METABOT_CORE_URL:-http://localhost:9200}"
    info "Local Core and Web UI are already running at $METABOT_CORE_URL"
    info "The installer saved the Bearer token without printing it."
  else
    echo "  MetaBot delegates MetaMemory / Skill Hub / Agents / T5T to your"
    echo "  metabot-core service (local by default)."
    prompt_input METABOT_CORE_URL "metabot-core URL" "${METABOT_CORE_URL:-http://localhost:9200}"

    echo ""
    if [[ -n "${METABOT_CORE_TOKEN:-}" ]]; then
      info "Using METABOT_CORE_TOKEN supplied by the environment (value not printed)."
    else
      info "Get your personal Bearer token:"
      info "  - first launch writes ~/.metabot-core/data/admin-bootstrap-token.txt"
      info "  - paste that token into the browser console or save it as ~/.metabot-core/token"
      info "  Paste the mt_... token below — or press Enter to configure later"
      info "     (later: drop it into ${METABOT_HOME}/.env or ~/.metabot-core/token)"
      prompt_secret METABOT_CORE_TOKEN "metabot-core Bearer token (blank = skip)"
    fi
  fi
fi

# ============================================================================
# Phase 5: Generate .env + bots.json
# ============================================================================
step "Phase 5: Generating configuration files"

if [[ "$SKIP_CONFIG" == "false" ]]; then
  # Generate .env
  {
    echo "# MetaBot Configuration (generated by install.sh)"
    echo "# $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo ""
    echo "# Bot config file (multi-bot mode)"
    echo "BOTS_CONFIG=./bots.json"
    echo ""
    echo "# API Server"
    echo "API_PORT=${API_PORT}"
    echo "API_SECRET=${API_SECRET}"
    echo ""
    echo "# Agent Engine Authentication"
    if [[ "$CLAUDE_AUTH_METHOD" == "subscription" ]]; then
      echo "# Using Claude Code Subscription (OAuth). Run 'claude login' to authenticate."
    elif [[ "$CLAUDE_AUTH_METHOD" == "kimi" ]]; then
      echo "# Using Kimi Code 0.27+ (default model: kimi-code/k3). Run 'kimi login' to authenticate."
    elif [[ "$CLAUDE_AUTH_METHOD" == "codex" ]]; then
      echo "# Using Codex CLI. Run 'codex login' to authenticate (or set OPENAI_API_KEY / configure ~/.codex/config.toml)."
      echo "# CODEX_EXECUTABLE_PATH="
      echo "# CODEX_APPROVAL_POLICY=never"
      echo "# CODEX_SANDBOX=workspace-write"
      echo "# install.sh also ensures ~/.codex/config.toml contains:"
      echo "#   [features]"
      echo "#   multi_agent = true"
      echo "#   memories = true"
      echo "#   guardian_approval = true"
      echo "#   prevent_idle_sleep = true"
    elif [[ -n "${CLAUDE_AUTH_ENV_LINES:-}" ]]; then
      echo "$CLAUDE_AUTH_ENV_LINES"
    fi
    echo ""
    echo "# Claude Settings"
    echo "CLAUDE_DEFAULT_WORKING_DIRECTORY=${WORK_DIR}"
    echo "# CLAUDE_MAX_TURNS="
    echo "# CLAUDE_MAX_BUDGET_USD="
    echo "LOG_LEVEL=${LOG_LEVEL}"
    if [[ -n "${CLAUDE_PATH:-}" ]]; then
      echo "CLAUDE_EXECUTABLE_PATH=${CLAUDE_PATH}"
    fi
    echo ""
    echo "# self-hosted metabot-core service (MetaMemory + Skill Hub + Agents + T5T)"
    echo "METABOT_CORE_URL=${METABOT_CORE_URL}"
    if [[ -n "${METABOT_CORE_TOKEN:-}" ]]; then
      echo "METABOT_CORE_TOKEN=${METABOT_CORE_TOKEN}"
    else
      echo "# First launch writes ~/.metabot-core/data/admin-bootstrap-token.txt"
      echo "# Paste it here OR save it to ~/.metabot-core/token (chmod 600)"
      echo "# METABOT_CORE_TOKEN="
    fi
    echo ""
    echo "# Optional local default env injection (do not commit real secrets)"
    echo "# Priority: real process env > project .env > local defaults."
    echo "#   METABOT_DEFAULT_ENV_FILE, /etc/metabot/default.env, ~/.metabot/default.env, .env.defaults"
    echo "# Optional default.env for Feishu voice replies:"
    echo "#   VOLCENGINE_TTS_APPID=..."
    echo "#   VOLCENGINE_TTS_ACCESS_KEY=..."
    echo "#   VOLCENGINE_TTS_RESOURCE_ID=volc.service_type.10029"
    echo "#   METABOT_VOICE_REPLY_DEFAULT_ON=true"
    echo "#   METABOT_VOICE_REPLY_PROVIDER=doubao"
    echo "#   METABOT_VOICE_REPLY_MAX_CHARS=400"
    echo "# Optional: spend a small number of LLM tokens to rewrite card text into a spoken decision brief."
    echo "#   METABOT_VOICE_REPLY_SUMMARY_PROVIDER=openai"
    echo "#   METABOT_VOICE_REPLY_SUMMARY_MODEL=gpt-4o-mini"
  } > "$METABOT_HOME/.env"
  chmod 600 "$METABOT_HOME/.env"
  success ".env generated"

  # Generate bots.json (use node for safe JSON escaping)
  BOTS_JSON="$METABOT_HOME/bots.json"
  FEISHU_BOTS_JSON="[]"
  TELEGRAM_BOTS_JSON="[]"
  WECHAT_BOTS_JSON="[]"

  if [[ "$SETUP_FEISHU" == "true" ]]; then
    FEISHU_BOTS_JSON=$(node -e "
      const engine = process.argv[5];
      const bot = {
        name: process.argv[1],
        engine,
        feishuAppId: process.argv[2],
        feishuAppSecret: process.argv[3],
        defaultWorkingDirectory: process.argv[4],
      };
      if (engine === 'kimi') { bot.kimi = { model: 'kimi-code/k3', thinking: true, permissionMode: 'auto' }; }
      if (engine === 'codex') { bot.codex = { approvalPolicy: 'never', sandbox: 'workspace-write' }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$BOT_NAME" "$FEISHU_APP_ID" "$FEISHU_APP_SECRET" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  if [[ "$SETUP_TELEGRAM" == "true" ]]; then
    TG_NAME="$BOT_NAME"
    [[ "$SETUP_FEISHU" == "true" ]] && TG_NAME="${BOT_NAME}-telegram"
    TELEGRAM_BOTS_JSON=$(node -e "
      const engine = process.argv[4];
      const bot = {
        name: process.argv[1],
        engine,
        telegramBotToken: process.argv[2],
        defaultWorkingDirectory: process.argv[3],
      };
      if (engine === 'kimi') { bot.kimi = { model: 'kimi-code/k3', thinking: true, permissionMode: 'auto' }; }
      if (engine === 'codex') { bot.codex = { approvalPolicy: 'never', sandbox: 'workspace-write' }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$TG_NAME" "$TELEGRAM_BOT_TOKEN" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  if [[ "$SETUP_WECHAT" == "true" ]]; then
    WX_NAME="$BOT_NAME"
    # Append suffix if other platforms are also configured
    [[ "$SETUP_FEISHU" == "true" || "$SETUP_TELEGRAM" == "true" ]] && WX_NAME="${BOT_NAME}-wechat"
    WECHAT_BOTS_JSON=$(node -e "
      const engine = process.argv[3];
      const bot = {
        name: process.argv[1],
        engine,
        defaultWorkingDirectory: process.argv[2],
      };
      if (engine === 'kimi') { bot.kimi = { model: 'kimi-code/k3', thinking: true, permissionMode: 'auto' }; }
      if (engine === 'codex') { bot.codex = { approvalPolicy: 'never', sandbox: 'workspace-write' }; }
      console.log(JSON.stringify([bot], null, 2))
    " "$WX_NAME" "$WORK_DIR" "${BOT_ENGINE:-claude}")
  fi

  node -e "
    const config = {};
    const feishu = JSON.parse(process.argv[1]);
    const telegram = JSON.parse(process.argv[2]);
    const wechat = JSON.parse(process.argv[3]);
    if (feishu.length > 0) config.feishuBots = feishu;
    if (telegram.length > 0) config.telegramBots = telegram;
    if (wechat.length > 0) config.wechatBots = wechat;
    console.log(JSON.stringify(config, null, 2));
  " "$FEISHU_BOTS_JSON" "$TELEGRAM_BOTS_JSON" "$WECHAT_BOTS_JSON" > "$BOTS_JSON"
  chmod 600 "$BOTS_JSON"

  # Validate generated JSON
  if ! node -e "JSON.parse(require('fs').readFileSync('$BOTS_JSON','utf-8'))" 2>/dev/null; then
    error "Generated bots.json is invalid. Please check your bot name and credentials for special characters."
    exit 1
  fi
  success "bots.json generated"
fi

# ============================================================================
# Phase 6: Install skills + workspace setup
# ============================================================================
step "Phase 6: Installing skills and setting up workspace"

SKILLS_DIR="$HOME/.claude/skills"
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
AGENTS_SKILLS_DIR="$HOME/.agents/skills"
GLOBAL_SKILL_ROOTS=("$SKILLS_DIR" "$CODEX_SKILLS_DIR" "$AGENTS_SKILLS_DIR")
mkdir -p "${GLOBAL_SKILL_ROOTS[@]}"

# Sanity check: bundled skill tree must exist in the checked-out repo.
# If it's missing, the user's checkout is stale (predates the skill bundling
# commits) — fail with a clear message instead of cryptic cp errors.
SKILL_SENTINEL="$METABOT_HOME/packages/skills/metabot/SKILL.md"
if [[ ! -f "$SKILL_SENTINEL" ]]; then
  error "Bundled skill source not found at: $SKILL_SENTINEL"
  error "Your $METABOT_HOME checkout appears to be stale or incomplete."
  error "Try: cd $METABOT_HOME && git fetch origin && git reset --hard origin/main"
  error "(WARNING: 'git reset --hard' discards uncommitted local changes.)"
  exit 1
fi
TEAM_SKILL_SENTINEL="$METABOT_HOME/packages/skills/metabot-team/SKILL.md"
if [[ ! -f "$TEAM_SKILL_SENTINEL" ]]; then
  error "Bundled metabot-team skill source not found at: $TEAM_SKILL_SENTINEL"
  exit 1
fi

# Clean up legacy metaskill skill if present — no longer installed by default.
# Users who still want the agent-team generator can copy it back from
# $METABOT_HOME/src/skills/metaskill/ (the source files remain bundled in the repo).
if [[ -d "$SKILLS_DIR/metaskill" ]]; then
  rm -rf "$SKILLS_DIR/metaskill"
  info "Removed legacy metaskill skill from $SKILLS_DIR (now opt-in — see src/skills/metaskill/)"
fi

# Clean up legacy skill bundles (Phase 4 consolidation: subsumed by unified
# `metabot` skill that delegates memory/skills/agents/t5t to metabot-core).
for legacy in metamemory skill-hub memory; do
  if [[ -d "$SKILLS_DIR/$legacy" ]]; then
    rm -rf "$SKILLS_DIR/$legacy"
    info "Removed legacy $legacy skill (use \`metabot ${legacy/skill-hub/skills}\` instead)"
  fi
done

# Install the complete MetaBot-owned skill bundles for Claude, Codex, and the
# shared Agent Skills location used by Kimi Code 0.27+. Copying the full bundle
# (rather than only SKILL.md) preserves required references and scripts.
declare -a METABOT_SKILL_NAMES=("metabot" "metabot-team")
declare -a METABOT_SKILL_SOURCES=(
  "$METABOT_HOME/packages/skills/metabot"
  "$METABOT_HOME/packages/skills/metabot-team"
)
for skill_index in "${!METABOT_SKILL_NAMES[@]}"; do
  skill_name="${METABOT_SKILL_NAMES[$skill_index]}"
  skill_source="${METABOT_SKILL_SOURCES[$skill_index]}"
  info "Installing $skill_name skill..."
  for skill_root in "${GLOBAL_SKILL_ROOTS[@]}"; do
    metabot_install_skill_bundle "$skill_source" "$skill_root/$skill_name" "$HOME/.metabot/skill-backups"
    success "$skill_name skill installed → $skill_root/$skill_name"
  done
done

# The voice CLI remains available, but the standalone voice Skill is retired.
for skill_root in "${GLOBAL_SKILL_ROOTS[@]}"; do
  if [[ -e "$skill_root/voice" || -L "$skill_root/voice" ]]; then
    metabot_backup_existing_skill "$skill_root/voice" "$HOME/.metabot/skill-backups"
    info "Retired voice Skill from $skill_root"
  fi
done

# Detect Feishu bots
HAS_FEISHU=false
if [[ "$SKIP_CONFIG" == "false" && "$SETUP_FEISHU" == "true" ]]; then
  HAS_FEISHU=true
elif [[ "$SKIP_CONFIG" == "true" && -f "$METABOT_HOME/bots.json" ]]; then
  # Detect from existing config
  if node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); process.exit((c.feishuBots||[]).length>0?0:1)" 2>/dev/null; then
    HAS_FEISHU=true
  fi
fi

# Install lark-cli and AI Agent skills — only when Feishu is configured
SETUP_LARK_CLI=false
if [[ "$HAS_FEISHU" == "true" ]]; then
  echo ""
  info "lark-cli provides 19 AI Agent skills for Feishu (docs, sheets, calendar, IM, etc.)"
  if prompt_yn "Install lark-cli and Feishu AI Agent skills?" "y"; then
    SETUP_LARK_CLI=true
  fi
fi

if [[ "$SETUP_LARK_CLI" == "true" ]]; then
  info "Installing lark-cli (Feishu official CLI)..."
  if command -v lark-cli &>/dev/null; then
    success "lark-cli already installed ($(lark-cli --version 2>/dev/null || echo 'unknown'))"
  else
    # Try global install, fall back to user-local prefix
    if npm install -g @larksuite/cli 2>/dev/null; then
      success "lark-cli installed globally"
    else
      mkdir -p "$HOME/.npm-global"
      npm config set prefix "$HOME/.npm-global"
      npm install -g @larksuite/cli 2>/dev/null
      # Ensure ~/.npm-global/bin is in PATH
      if ! echo "$PATH" | grep -q "$HOME/.npm-global/bin"; then
        export PATH="$HOME/.npm-global/bin:$PATH"
        echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.bashrc"
        info "Added ~/.npm-global/bin to PATH in ~/.bashrc"
      fi
      success "lark-cli installed to ~/.npm-global/bin"
    fi
  fi

  # Configure lark-cli with first Feishu bot credentials
  if [[ ! -f "$HOME/.lark-cli/config.json" && -f "$METABOT_HOME/bots.json" ]]; then
    FEISHU_APP_ID=$(node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); console.log((c.feishuBots||[])[0]?.feishuAppId||'')" 2>/dev/null)
    FEISHU_APP_SECRET=$(node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); console.log((c.feishuBots||[])[0]?.feishuAppSecret||'')" 2>/dev/null)
    if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]]; then
      echo "$FEISHU_APP_SECRET" | lark-cli config init --app-id "$FEISHU_APP_ID" --app-secret-stdin --brand feishu 2>/dev/null && \
        success "lark-cli configured with app $FEISHU_APP_ID" || \
        warn "lark-cli config failed — you can run manually: lark-cli config init"
    fi
  fi

  # Install lark-cli AI Agent skills for Claude Code
  info "Installing lark-cli AI Agent skills..."
  if npx skills add larksuite/cli --all -y -g 2>/dev/null; then
    success "lark-cli AI Agent skills installed (19 skills)"
  else
    warn "lark-cli skills install failed — you can run manually: npx skills add larksuite/cli --all -y -g"
  fi
fi

# Clean up old feishu-doc skill if present
if [[ -d "$SKILLS_DIR/feishu-doc" ]]; then
  rm -rf "$SKILLS_DIR/feishu-doc"
  info "Removed legacy feishu-doc skill (replaced by lark-cli skills)"
fi

# Determine working directory
if [[ "$SKIP_CONFIG" == "false" ]]; then
  DEPLOY_WORK_DIR="$WORK_DIR"
else
  if [[ -f "$METABOT_HOME/bots.json" ]]; then
    DEPLOY_WORK_DIR=$(node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$METABOT_HOME/bots.json','utf-8'));
      const bots = [...(cfg.feishuBots||[]),...(cfg.telegramBots||[]),...(cfg.wechatBots||[])];
      if (bots[0]) console.log(bots[0].defaultWorkingDirectory);
    " 2>/dev/null || echo "")
  else
    DEPLOY_WORK_DIR=""
  fi
fi

# Retire project-level MetaBot Skill mirrors and deploy only user-selected Lark
# mirrors. Workspace instruction files are user-owned and never changed.
if [[ -n "${DEPLOY_WORK_DIR:-}" ]]; then
  SKILLS_DEST="$DEPLOY_WORK_DIR/.claude/skills"
  CODEX_SKILLS_DEST="$DEPLOY_WORK_DIR/.codex/skills"
  AGENTS_SKILLS_DEST="$DEPLOY_WORK_DIR/.agents/skills"
  WORKSPACE_SKILL_ROOTS=("$SKILLS_DEST" "$CODEX_SKILLS_DEST" "$AGENTS_SKILLS_DEST")
  mkdir -p "${WORKSPACE_SKILL_ROOTS[@]}"

  # Clean up legacy skill bundles from a previously-deployed workspace so the
  # bot doesn't load stale skills after the Phase 4 consolidation.
  for legacy in metamemory skill-hub; do
    for skill_dest in "${WORKSPACE_SKILL_ROOTS[@]}"; do
      if [[ -e "$skill_dest/$legacy" || -L "$skill_dest/$legacy" ]]; then
        metabot_backup_existing_skill "$skill_dest/$legacy" "$DEPLOY_WORK_DIR/.metabot/skill-backups"
        info "Retired legacy $legacy from $skill_dest"
      fi
    done
  done

  # MetaBot-owned Skills are global-only. Preserve and retire historical
  # project copies so stale snapshots cannot shadow newer global Skills.
  for SKILL in metabot metabot-team voice; do
    for skill_dest in "${WORKSPACE_SKILL_ROOTS[@]}"; do
      if [[ -e "$skill_dest/$SKILL" || -L "$skill_dest/$SKILL" ]]; then
        metabot_backup_existing_skill "$skill_dest/$SKILL" "$DEPLOY_WORK_DIR/.metabot/skill-backups"
        info "Retired project-level $SKILL mirror from $skill_dest"
      fi
    done
  done

  DEPLOY_SKILLS=""
  if [[ "$SETUP_LARK_CLI" == "true" ]]; then
    for lark_skill in lark-base lark-calendar lark-contact lark-doc lark-drive lark-event lark-im lark-mail lark-minutes lark-openapi-explorer lark-shared lark-sheets lark-skill-maker lark-task lark-vc lark-whiteboard lark-wiki lark-workflow-meeting-summary lark-workflow-standup-report; do
      [[ -d "$SKILLS_DIR/$lark_skill" ]] && DEPLOY_SKILLS="$DEPLOY_SKILLS $lark_skill"
    done
  fi
  for SKILL in $DEPLOY_SKILLS; do
    if [[ -d "$SKILLS_DIR/$SKILL" ]]; then
      for skill_dest in "${WORKSPACE_SKILL_ROOTS[@]}"; do
        mkdir -p "$skill_dest/$SKILL"
        cp -R "$SKILLS_DIR/$SKILL/." "$skill_dest/$SKILL/"
        success "Deployed $SKILL → $skill_dest/$SKILL"
      done
    fi
  done

  rm -f "$DEPLOY_WORK_DIR/.metabot/workspace-harness.sha256"

else
  warn "Could not determine working directory, skipping workspace mirror cleanup"
fi

# ============================================================================
# Phase 7: Legacy MetaMemory cleanup (embedded MetaMemory removed in Phase 4)
# ============================================================================
step "Phase 7: Legacy MetaMemory cleanup"

info "MetaMemory is now served by metabot-core at ${METABOT_CORE_URL:-http://localhost:9200}."
info "No local DB, no embedded server — the bridge talks to the central service via HTTP."

# Stop old embedded/standalone MetaMemory PM2 process if it still exists.
if pm2 describe metamemory &>/dev/null 2>&1; then
  info "Stopping legacy MetaMemory PM2 process..."
  pm2 delete metamemory 2>/dev/null || true
  success "Legacy MetaMemory process removed"
fi

# Free port 8100 if a stale embedded server is still listening.
if command -v lsof &>/dev/null; then
  OLD_PID=$(lsof -ti :8100 2>/dev/null || true)
  if [[ -n "$OLD_PID" ]]; then
    info "Killing leftover process on port 8100 (PID: $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Old standalone-Python MetaMemory data dir lingers harmlessly — leave it.
if [[ -d "$HOME/.metamemory-data" ]]; then
  info "Note: legacy ~/.metamemory-data/ left in place (safe to delete after data export)."
fi

BASH_ALIASES="$HOME/.bash_aliases"

# Strip the legacy mm() shortcut from a pre-existing ~/.bash_aliases — it
# targets localhost:8100 which no longer exists after the Phase 4 pivot.
# Use `metabot memory ...` instead (delegates to metabot-core).
if [[ -f "$BASH_ALIASES" ]] && grep -q '^mm()' "$BASH_ALIASES" 2>/dev/null; then
  info "Removing legacy mm() shortcut from $BASH_ALIASES (use \`metabot memory ...\` now)..."
  # Delete the MetaMemory shortcuts block: from "# MetaMemory shortcuts (installed by MetaBot)"
  # down to and including the closing "}" of mm(). Then drop the matching export lines.
  python3 - "$BASH_ALIASES" <<'PYEOF'
import sys, re
path = sys.argv[1]
with open(path) as f:
    text = f.read()
pattern = re.compile(
    r"\n?# MetaMemory shortcuts \(installed by MetaBot\)\n"
    r"export MEMORY_URL=.*\n"
    r"export MEMORY_AUTH=.*\n\n"
    r"mm\(\) \{.*?\n\}\n",
    re.DOTALL,
)
new = pattern.sub("", text)
with open(path, "w") as f:
    f.write(new)
PYEOF
  success "Legacy mm() shortcut removed"
fi

# Install metabot as a standalone executable in ~/.local/bin (no source needed).
# `metabot` is the single CLI binary (bridge process control + bridge daemon API
# + delegation to the metabot-core feature CLI).
LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
CLI_TOOLS="metabot"
for cli in $CLI_TOOLS; do
  src="$METABOT_HOME/bin/$cli"
  dst="$LOCAL_BIN/$cli"
  if [[ -f "$src" ]]; then
    # Skip if $dst is already a symlink to $src (user-curated layout) — copying
    # a file onto its own symlink target errors out with `cp: 'a' and 'b' are
    # the same file`.
    if [[ "$src" -ef "$dst" ]]; then
      continue
    fi
    cp "$src" "$dst"
    chmod +x "$dst"
  fi
done
# Clean up legacy CLIs: mb (deprecation shim, now removed), fd (old shortcut),
# mbcore (temp Phase 4 shim), mm/mh (metabot-core feature CLIs subsumed by
# `metabot` dispatcher).
for legacy_cli in mb fd mbcore mm mh; do
  if [[ -f "$LOCAL_BIN/$legacy_cli" || -L "$LOCAL_BIN/$legacy_cli" ]]; then
    # Only remove regular files / symlinks living inside ~/.local/bin — never
    # touch system-installed binaries elsewhere on PATH.
    rm -f "$LOCAL_BIN/$legacy_cli"
  fi
done
# Ensure ~/.local/bin is in PATH (most distros include it, but not all)
if ! echo "$PATH" | grep -q "$LOCAL_BIN"; then
  echo "export PATH=\"$LOCAL_BIN:\$PATH\"" >> "$HOME/.bashrc"
  info "Added ~/.local/bin to PATH in ~/.bashrc"
fi
success "metabot CLI installed to $LOCAL_BIN"

# Persist METABOT_HOME for non-default install paths so the CLI tool
# (metabot) can find the install in new shell sessions. The CLI falls
# back to $HOME/metabot, so we only need to export when it differs.
if [[ "$METABOT_HOME" != "$DEFAULT_METABOT_HOME" ]]; then
  for rc_file in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [[ -f "$rc_file" ]] || continue
    # Drop any prior export to keep this idempotent across re-runs.
    if grep -q '^export METABOT_HOME=' "$rc_file" 2>/dev/null; then
      sed_i '/^export METABOT_HOME=/d' "$rc_file"
    fi
  done
  echo "export METABOT_HOME=\"$METABOT_HOME\"" >> "$HOME/.bashrc"
  if [[ -f "$HOME/.zshrc" ]]; then
    echo "export METABOT_HOME=\"$METABOT_HOME\"" >> "$HOME/.zshrc"
  fi
  info "Persisted METABOT_HOME=$METABOT_HOME to shell rc files"
fi

# ============================================================================
# Phase 8: Build + Start MetaBot with PM2
# ============================================================================
step "Phase 8: Starting MetaBot"

cd "$METABOT_HOME"

info "Building bridge TypeScript..."
if npm run build:bridge; then
  success "Bridge build complete"
else
  error "Bridge build failed. MetaBot was not started."
  exit 1
fi

# The metabot shell command delegates memory/t5t/skills/agents to
# packages/cli/dist/index.js. Release tarballs intentionally contain source,
# not dist/, so a successful install must build this workspace explicitly.
info "Building metabot CLI..."
if npm run build -w @xvirobotics/cli; then
  success "CLI build complete"
else
  error "CLI build failed. MetaBot was not started."
  exit 1
fi

# Always delete + start fresh to avoid stale/stopped process issues
if pm2 describe metabot &>/dev/null 2>&1; then
  info "Removing old MetaBot PM2 process..."
  pm2 delete metabot 2>/dev/null || true
fi
info "Starting MetaBot with PM2..."
pm2 start ecosystem.config.cjs

pm2 save --force 2>/dev/null || true
success "MetaBot is running!"

# --- WeChat QR login: wait for URL and display it ---
HAS_WECHAT_BOT=false
if [[ "$SKIP_CONFIG" == "false" && "${SETUP_WECHAT:-false}" == "true" ]]; then
  HAS_WECHAT_BOT=true
elif [[ "$SKIP_CONFIG" == "true" && -f "$METABOT_HOME/bots.json" ]]; then
  if node -e "const c=JSON.parse(require('fs').readFileSync('$METABOT_HOME/bots.json','utf-8')); process.exit((c.wechatBots||[]).length>0?0:1)" 2>/dev/null; then
    HAS_WECHAT_BOT=true
  fi
fi

if [[ "$HAS_WECHAT_BOT" == "true" ]]; then
  echo ""
  info "WeChat ClawBot detected — waiting for QR login URL..."
  WX_QR_URL=""
  LOG_FILE="$METABOT_HOME/logs/out.log"
  for i in $(seq 1 15); do
    sleep 2
    if [[ -f "$LOG_FILE" ]]; then
      WX_QR_URL=$(grep -oP 'Open this URL or scan the QR code: \K\S+' "$LOG_FILE" 2>/dev/null | tail -1 || true)
      if [[ -n "$WX_QR_URL" ]]; then
        break
      fi
    fi
  done

  if [[ -n "$WX_QR_URL" ]]; then
    echo ""
    echo -e "  ${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
    echo -e "  ${GREEN}${BOLD}║  WeChat ClawBot — Scan QR Code to bind      ║${NC}"
    echo -e "  ${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}${WX_QR_URL}${NC}"
    echo ""
    echo "  Open the URL above in your browser, then scan the QR code with WeChat."
    echo "  The bot will automatically connect after scanning."
    echo ""
  else
    warn "QR URL not yet available. Check logs to get it:"
    echo "    pm2 logs metabot --lines 30"
  fi
fi

# ============================================================================
# Phase 9: Summary
# ============================================================================
echo ""
echo -e "${GREEN}${BOLD}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║           MetaBot — Ready!               ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo ""
echo -e "  ${BOLD}Installation:${NC}   ${METABOT_HOME}"
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Working Dir:${NC}    ${WORK_DIR}"
  echo -e "  ${BOLD}API:${NC}            http://localhost:${API_PORT}"
  echo -e "  ${BOLD}API Secret:${NC}     ${API_SECRET:0:8}...${API_SECRET: -4}"
  echo -e "  ${BOLD}Engine:${NC}         ${BOT_ENGINE:-claude}"
  echo -e "  ${BOLD}Auth Method:${NC}    ${CLAUDE_AUTH_METHOD}"
  if [[ "${CLAUDE_AUTH_METHOD}" == "third_party" ]]; then
    echo -e "  ${BOLD}Provider:${NC}       ${PROVIDER_NAME}"
  fi
fi
CORE_URL_DISPLAY="${METABOT_CORE_URL:-http://localhost:9200}"
echo -e "  ${BOLD}metabot-core:${NC}    ${CORE_URL_DISPLAY}"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    pm2 logs metabot          # View MetaBot logs"
if [[ "$PERSONAL_LOCAL_CORE" == "true" ]]; then
  echo "    pm2 logs metabot-core     # View local Core logs"
  echo "    open http://localhost:9200 # Personal Web UI (or use your browser)"
fi
echo "    pm2 restart metabot       # Restart MetaBot"
echo "    pm2 stop metabot          # Stop MetaBot"
echo "    metabot memory list       # Browse central memory (delegated to metabot-core)"
echo "    metabot memory visibility # Per-bot default: /shared (public) vs /users (private); flip with 'visibility private|public'"
echo "    metabot skills list       # List shared skills"
echo "    metabot agents list       # List visible agents"
echo "    metabot t5t board         # T5T project board"
echo ""
if [[ -z "${METABOT_CORE_TOKEN:-}" ]]; then
  echo -e "  ${BOLD}metabot-core onboarding:${NC}"
  echo "    1. Grab the first token from ~/.metabot-core/data/admin-bootstrap-token.txt"
  echo "       and paste it into the browser login screen if you use the console"
  echo "    2. Paste it into ${METABOT_HOME}/.env as METABOT_CORE_TOKEN=mt_..."
  echo "       (or save to ~/.metabot-core/token, chmod 600)"
  echo ""
fi
if [[ "${SKIP_CONFIG}" == "false" ]]; then
  echo -e "  ${BOLD}Next Steps:${NC}"
  STEP_NUM=1
  if [[ "${CLAUDE_AUTH_METHOD}" == "subscription" ]]; then
    echo "    ${STEP_NUM}. Run 'claude login' in a separate terminal"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${CLAUDE_AUTH_METHOD}" == "kimi" ]]; then
    echo "    ${STEP_NUM}. Run 'kimi login' in a separate terminal (https://kimi.com to sign up)"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${CLAUDE_AUTH_METHOD}" == "codex" ]]; then
    if ! command -v codex &>/dev/null; then
      echo "    ${STEP_NUM}. Install Codex CLI: sudo npm install -g @openai/codex"
      STEP_NUM=$((STEP_NUM + 1))
    fi
    echo "    ${STEP_NUM}. Run 'codex login' in a separate terminal (or set OPENAI_API_KEY / configure ~/.codex/config.toml)"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "$SETUP_FEISHU" == "true" ]]; then
    echo "    ${STEP_NUM}. Configure Feishu app: enable long-connection events + im.message.receive_v1 + publish"
    STEP_NUM=$((STEP_NUM + 1))
    echo "    ${STEP_NUM}. Open Feishu and message your bot"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${SETUP_TELEGRAM:-false}" == "true" ]]; then
    echo "    ${STEP_NUM}. Open Telegram and message your bot — it's ready now!"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  if [[ "${SETUP_WECHAT:-false}" == "true" ]]; then
    echo "    ${STEP_NUM}. Scan the WeChat QR code shown above (or check pm2 logs metabot)"
    STEP_NUM=$((STEP_NUM + 1))
    echo "    ${STEP_NUM}. Send a message to your ClawBot in WeChat"
    STEP_NUM=$((STEP_NUM + 1))
  fi
  echo "    ${STEP_NUM}. Check logs: pm2 logs metabot"
fi
echo ""
