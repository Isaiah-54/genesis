#!/usr/bin/env bash
# Build Genesis Core (Rust -> WASM) on this host.
# Log: ~/workspace/genesis/build-core-local.log
# Exit 0 only if target/near/genesis_core.wasm exists after the build.
set -u
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TERM_COLOR=never
# /tmp is a 512 MB tmpfs and cargo install fills it (aws-lc C build).
# Point all temp files at the home disk (147 GB free) instead.
mkdir -p "$HOME/.tmp"
export TMPDIR="$HOME/.tmp"
export TMP="$HOME/.tmp"
export TEMP="$HOME/.tmp"
cd ~/workspace/genesis/contracts/genesis-core || exit 1

echo "=== rustup ==="
if ! command -v rustup >/dev/null 2>&1; then
  echo "Installing rustup (stable, minimal profile)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal || exit 2
fi
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
rustc --version; cargo --version; rustup --version

echo "=== wasm target ==="
rustup target add wasm32-unknown-unknown || exit 3

echo "=== cargo-near ==="
if ! command -v cargo-near >/dev/null 2>&1; then
  echo "Installing cargo-near (this compiles a large crate; may take 10+ minutes)..."
  cargo install cargo-near || exit 4
fi
cargo near --version

echo "=== build ==="
# cargo-near 0.22 requires a subcommand; bare `cargo near build` prompts
# interactively and fails with "input device is not a TTY" off-terminal.
cargo near build non-reproducible-wasm || exit 5

echo "=== output ==="
ls -la target/near/
test -f target/near/genesis_core.wasm || { echo "WASM NOT FOUND at target/near/genesis_core.wasm"; exit 6; }
sha256sum target/near/genesis_core.wasm
echo "BUILD OK"
