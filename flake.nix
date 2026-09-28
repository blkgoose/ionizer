{
  description = "ionizer - ION visualizer web client";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_22;
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "ionizer-client";
          version = "0.0.0";
          src = ./client;
          inherit nodejs;
          npmDepsHash = "sha256-qXmhe0vq8u/2zb/t3cKry6F+XK+JWOTrmDIUcbwuSBY=";
          installPhase = ''
            runHook preInstall
            cp -r dist $out
            runHook postInstall
          '';
        };

        apps.default = {
          type = "app";
          program = toString (pkgs.writeShellScript "ionizer-dev" ''
            cd client
            [ -d node_modules ] || ${nodejs}/bin/npm ci
            exec ${nodejs}/bin/npm run dev
          '');
        };

        devShells.default = pkgs.mkShell {
          packages = [ nodejs ];
        };
      });
}
