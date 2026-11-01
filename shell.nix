# Compatibility entry point: `nix-shell shell.nix --run ./check.sh` predates
# flakes, and the README and CI already use it. It now derives from flake.nix,
# so the pinned revision lives in one place (flake.lock) rather than in two
# files that can disagree.
#
# For the flake-native form, use: nix develop --command ./check.sh
{ ... }:
let
  flake = builtins.getFlake (toString ./.);
  system = builtins.currentSystem;
in
flake.devShells.${system}.default
