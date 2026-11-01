#!/usr/bin/env bash
# Generator for the embedded fonts, pinned to nixpkgs so the bytes are
# reproducible from flake.lock. The output is committed: this script is the only
# part of the project that wants network, and it is not needed to build, test,
# or view the artifact.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="${PATH:+$PATH:}/nix/store/qshvhyv92g772jjsm2zrgzxc4ai4iqfx-nodejs-22.23.3/bin"

# Resolve the font directory first, then hand it to the generator as an
# argument: `nix shell` does not export the installed paths as shell variables.
#
# This is the package *out path*, not a subdirectory of it. An interpolated
# "${pkg}/subdir" string carries a derivation context that nix rejects unless
# the path is exactly the output, so the subdirectory is appended in bash.
FONT_OUT=$(
  nix build --impure --no-link --print-out-paths --expr '
    let flake = builtins.getFlake (toString ./.);
        pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
    in pkgs.dejavu_fonts
  '
)
FONT_DIR="$FONT_OUT/share/fonts/truetype"

# fonttools needs the Brotli Python extension to encode WOFF2 but does not
# declare it, so pyftsubset fails only when it writes the output file.
nix shell --impure --expr '
  let flake = builtins.getFlake (toString ./.);
      pkgs = flake.inputs.nixpkgs.legacyPackages.${builtins.currentSystem};
  in [
    pkgs.python3Packages.fonttools
    pkgs.woff2
  ]
' --command node tools/build-font.mjs "$FONT_DIR"
