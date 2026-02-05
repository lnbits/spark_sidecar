{
  description = "Spark L2 sidecar (LNbits sidecar)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pname = "lnbits-spark-sidecar";
        version = "0.0.0";

        package = pkgs.buildNpmPackage {
          inherit pname version;
          src = ./.;
          npmDepsHash = "sha256-IF87onWOqsv3vtrGWpP95zaaUpRtKiDJ5NokNWDAzEQ=";

          dontNpmBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/node_modules/${pname}
            cp -r . $out/lib/node_modules/${pname}
            runHook postInstall
          '';
        };

        runSidecar = pkgs.writeShellApplication {
          name = "spark-sidecar";
          runtimeInputs = [ pkgs.nodejs_20 ];
          text = ''
            export NODE_PATH=${package}/lib/node_modules/${pname}/node_modules
            exec ${pkgs.nodejs_20}/bin/node ${package}/lib/node_modules/${pname}/server.mjs
          '';
        };
      in
      {
        packages.default = package;
        apps.default = flake-utils.lib.mkApp { drv = runSidecar; };
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_20 pkgs.nodePackages.npm ];
        };
      });
}
