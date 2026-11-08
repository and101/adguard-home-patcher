# AdGuard Home Patcher

Adds a few frontend improvements to the official AdGuard Home binary and Docker image. Only the web UI is changed: your AdGuard Home configuration, DNS data and server-side Query Log are left alone.

## Features

- Dashboard time ranges: last few hours, today, last N days or a custom range.
- Live Query Log with pause, queued arrivals, filters and a browser-only "Clear view". See the [screenshots](docs/live-query-log-controls.md).
- Updates are manual. Nothing is scheduled on your host.
- Falls back to the stock dashboard if the installed frontend doesn't match your AdGuard Home version.

## Requirements

- An existing AdGuard Home installation on Linux.
- Python 3.9+, curl, CA certificates, tar and `sha256sum`.
- Native installs: the `AdGuardHome.service` systemd unit.
- Docker installs: the official `adguard/adguardhome` image and Docker Compose.

## Install

The bootstrap script detects your AdGuard Home version, downloads the matching `agh-patcher-tools.tar.gz` from the `ui-<version>` [release](https://github.com/and101/adguard-home-patcher/releases), checks its SHA-256, extracts it to `/opt/adguardhome-patcher` and runs the installer inside it. Installing the tools doesn't download a frontend or restart AdGuard Home; that happens when you run `agh-patcher update`.

### Native

```sh
curl -fsSL https://raw.githubusercontent.com/and101/adguard-home-patcher/main/install.sh -o /tmp/agh-patcher-install.sh
sudo sh /tmp/agh-patcher-install.sh native
agh-patcher check
sudo agh-patcher update
```

AdGuard Home is expected in `/opt/AdGuardHome`. If yours lives elsewhere, run `sudo env AGH_DIR=/your/AdGuardHome sh /tmp/agh-patcher-install.sh native`.

### Docker

Run the bootstrap on the host, then bring the container up with the generated override from your Compose directory:

```sh
curl -fsSL https://raw.githubusercontent.com/and101/adguard-home-patcher/main/install.sh -o /tmp/agh-patcher-install.sh
sudo sh /tmp/agh-patcher-install.sh docker adguardhome
sudo docker compose -f compose.yaml \
  -f /opt/adguardhome-patcher/compose.patcher.yaml up -d adguardhome
agh-patcher check
sudo agh-patcher update
```

Docker mode takes `<container-name> [compose-service-name]`. The service name defaults to the container's Compose label, falling back to the container name. If your names differ, use something like `docker agh-container dns` and `up -d dns`, and substitute your own base Compose file.

The patcher owns `compose.patcher.yaml`; your base Compose file and volumes stay yours. The override doesn't replace your service command or other settings. Always pass both files to `docker compose` from now on.

### Manual install

If you'd rather not pipe a script, set `AGH_VERSION` to your installed version (with the `v`) and fetch the tools yourself:

```sh
AGH_VERSION=v0.107.79
(
  set -eu
  printf '%s\n' "$AGH_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$'
  tools_dir=$(mktemp -d)
  trap 'rm -rf "$tools_dir"' EXIT
  cd "$tools_dir"
  release_url="https://github.com/and101/adguard-home-patcher/releases/download/ui-$AGH_VERSION"
  curl -fL --retry 2 "$release_url/agh-patcher-tools.tar.gz" -o agh-patcher-tools.tar.gz
  curl -fL --retry 2 "$release_url/agh-patcher-tools.tar.gz.sha256" -o agh-patcher-tools.tar.gz.sha256
  sha256sum -c agh-patcher-tools.tar.gz.sha256
  sudo install -d -m 755 /opt/adguardhome-patcher
  sudo tar --no-same-owner --no-same-permissions -xzf agh-patcher-tools.tar.gz -C /opt/adguardhome-patcher
)
```

Then run either `sudo sh /opt/adguardhome-patcher/install/native/install.sh` (prefix with `env AGH_DIR=...` for a custom path) or `sudo sh /opt/adguardhome-patcher/install/docker/install.sh <container-name> [compose-service-name]`.

## Update

```sh
agh-patcher status
agh-patcher check
sudo agh-patcher update
```

- `status` only looks at the local install.
- `check` compares against the matching release and reports frontend and tooling updates separately.
- `update` downloads and verifies the frontend, shows what will change and asks you to type `yes` before replacing files and restarting AdGuard Home. Pass `--yes` to skip the prompt.

To update the management tooling itself, rerun the bootstrap (or the manual install). On Docker this regenerates the override but doesn't restart the container; if `check` says the override isn't active, run the Compose command above.

If you change the Docker image or the base service command: recreate the container with only the base Compose file, rerun the Docker installer, then apply the override again.

Hard-refresh your browser after a frontend update.

## Uninstall

Native:

```sh
sudo agh-patcher uninstall
```

Docker: recreate the container from the base Compose file first, then uninstall:

```sh
sudo docker compose -f compose.yaml up -d --force-recreate adguardhome
sudo agh-patcher uninstall
```

Uninstall asks for `yes`, restores the stock UI and removes the patcher's files. Your AdGuard Home configuration and data are kept. On Docker it refuses to run while the patcher's mounts are still attached. You can delete `/opt/adguardhome-patcher` afterwards.

## How it works

Only the frontend is patched. Each release is built for one exact AdGuard Home version, and every download is checked against published SHA-256 checksums and a file manifest. Updates keep the previous frontend for rollback and use an on-disk journal so an interrupted update can be recovered. More detail in [Safety and recovery](docs/safety-and-recovery.md).

[Development](docs/development.md) · [GPL-3.0](LICENSE) · Not an official AdGuard product.
