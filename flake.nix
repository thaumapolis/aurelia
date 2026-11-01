{
  description = "Aurelia: an instrument you draw with your finger, and its checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # The checks paint screenshots and compare them pixel for pixel, so the
      # set of systems is not cosmetic: each needs the same fonts and the same
      # browsers for a baseline to mean anything.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
            pkgs.python3
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute path.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/package/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Aurelia: ./check.sh   (build, syntax, tests, engines, goldens)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact, built from source, with nothing else in the way: the
        # result is the single index.html the project is distributed as.
        default = pkgs.runCommand "aurelia" {
          src = ./.;
          nativeBuildInputs = [ pkgs.nodejs_22 ];
        } ''
          cd "$src"
          node tools/build.mjs
          test -s index.html
          mkdir -p "$out"
          cp index.html "$out/index.html"
        '';
      });
    };
}
