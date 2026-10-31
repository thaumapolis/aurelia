# Reproducible toolchain for the checks:
#   nix-shell shell.nix --run ./check.sh
#
# Everything comes from nixpkgs, so the same command works on another machine
# and produces the same pictures. Node alone is enough to run the tests;
# Playwright and its Chromium are what the golden screenshots need.
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShellNoCC {
  packages = [
    pkgs.nodejs_22
    pkgs.playwright-driver
    pkgs.git
    pkgs.python3
    # styles.css asks for `ui-sans-serif, system-ui`, which otherwise resolves to
    # whatever fonts the host happens to have. Golden images containing text
    # would then differ between machines, so fontconfig gives that keyword a
    # defined answer and the baselines mean the same thing everywhere.
    pkgs.fontconfig
    pkgs.dejavu_fonts
    pkgs.liberation_ttf
  ];

  env = {
    # ESM ignores NODE_PATH, so the driver is addressed by absolute path.
    PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/package/index.mjs";
    PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
  };

  shellHook = ''
    echo "Aurelia: ./check.sh   (build, syntax, tests, golden screenshots)"
  '';
}
