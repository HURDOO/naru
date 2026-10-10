#!/bin/bash
# Update the npm-global Codex and Claude Code CLIs that shells and Naru Panes share.
# Naru launches the exact package-owned executables below, so an in-place npm update
# reaches a Pane the next time it is restarted (Ctrl+C, then resume).
set -euo pipefail

CODEX_PACKAGE="@openai/codex"
CLAUDE_PACKAGE="@anthropic-ai/claude-code"

usage() {
  cat <<'EOF'
Usage: update-agent-clis.sh [--check] [--ssh-daemon]

  --check       Report installed/latest versions and PATH resolution only.
  --ssh-daemon  Also update the Codex SSH app-server daemon package.
                This restarts the daemon and disconnects SSH Codex sessions.
EOF
}

check_only=0
ssh_daemon=0
for argument in "$@"; do
  case "$argument" in
    --check) check_only=1 ;;
    --ssh-daemon) ssh_daemon=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown option: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

[ "$(id -u)" -ne 0 ] || fail "run as the target user, not root"
npm_bin="$(command -v npm)" || fail "npm is not on PATH"
npm_root="$(cd "$("$npm_bin" root -g)" && pwd -P)"
codex_dir="$npm_root/$CODEX_PACKAGE"
claude_dir="$npm_root/$CLAUDE_PACKAGE"

installed_version() {
  [ -f "$1/package.json" ] || { echo "-"; return; }
  sed -n 's/^  "version": "\(.*\)",*$/\1/p' "$1/package.json" | head -1
}

# The executables Naru is configured with: real files, never version-named paths.
codex_executable() {
  local candidate
  for candidate in "$codex_dir"/node_modules/@openai/codex-*/vendor/*/bin/codex; do
    [ -f "$candidate" ] && { echo "$candidate"; return; }
  done
}
claude_executable() { echo "$claude_dir/bin/claude.exe"; }

resolve() { python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

report_path() {
  local name="$1" package_dir="$2" found
  if ! found="$(command -v "$name")"; then
    warn "$name is not on PATH"
    return
  fi
  case "$(resolve "$found")" in
    "$package_dir"/*) echo "  $name on PATH -> npm package" ;;
    *) warn "$name on PATH resolves outside $package_dir: $(resolve "$found")" ;;
  esac
}

report() {
  echo "npm root: $npm_root"
  echo "  $CODEX_PACKAGE: installed $(installed_version "$codex_dir"), latest $("$npm_bin" view "$CODEX_PACKAGE" version)"
  echo "  $CLAUDE_PACKAGE: installed $(installed_version "$claude_dir"), latest $("$npm_bin" view "$CLAUDE_PACKAGE" version)"
  report_path codex "$codex_dir"
  report_path claude "$claude_dir"
  local codex_path daemon
  codex_path="$(codex_executable)"
  if [ -n "$codex_path" ] && daemon="$("$codex_path" app-server daemon version 2>/dev/null)"; then
    echo "  codex SSH daemon: $daemon"
  fi
}

report
[ "$check_only" -eq 0 ] || exit 0

# A Homebrew cask owns the shared `claude` link; npm cannot replace it.
claude_link="$(dirname "$npm_bin")/claude"
if [ -L "$claude_link" ] && case "$(readlink "$claude_link")" in *Caskroom*) true ;; *) false ;; esac; then
  fail "a Homebrew cask owns $claude_link; run 'brew uninstall --cask claude-code@latest' first"
fi

echo "Updating $CODEX_PACKAGE and $CLAUDE_PACKAGE..."
# Claude Code's postinstall places the native binary at bin/claude.exe; allow only that script.
"$npm_bin" install -g --allow-scripts="$CLAUDE_PACKAGE" "$CODEX_PACKAGE@latest" "$CLAUDE_PACKAGE@latest"

codex_path="$(codex_executable)"
claude_path="$(claude_executable)"
[ -n "$codex_path" ] || fail "Codex native executable is missing under $codex_dir"
[ -f "$claude_path" ] && [ "$(wc -c <"$claude_path")" -gt 1048576 ] ||
  fail "Claude native executable was not placed at $claude_path"
echo "Naru executables:"
echo "  codex:  $codex_path ($("$codex_path" --version | tail -1))"
echo "  claude: $claude_path ($("$claude_path" --version | head -1))"

if [ "$ssh_daemon" -eq 1 ]; then
  echo "Updating the Codex SSH app-server daemon (SSH Codex sessions will disconnect)..."
  "$codex_path" app-server daemon update
  "$codex_path" app-server daemon version
fi

echo "Done. Restart a Pane to use the new version: Ctrl+C, then resume."
