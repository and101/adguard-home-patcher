# Safety and recovery

## Installing

Install from the checksummed `agh-patcher-tools.tar.gz` in the `ui-<version>` release, as described in the [README](../README.md). Its `TOOLS.json` lists the AdGuard Home version it supports and a hash for every file; the installer checks both before doing anything. Installing never downloads a frontend or restarts AdGuard Home, and rerunning it keeps your settings and any installed frontend.

## Commands

- `agh-patcher status` reads local state only and never contacts GitHub.
- `agh-patcher check` compares your install with the matching release. It doesn't change anything.
- `sudo agh-patcher update` explains what it's about to do and waits for you to type `yes` (or pass `--yes`). If the frontend is already current and healthy it does nothing.
- `sudo agh-patcher uninstall` removes the CLI, launcher, config, managed frontend and rollback copies. Native installs also lose the systemd drop-in; AdGuard Home is restarted and checked before frontend files are deleted. On Docker, recreate the container without the override first. AdGuard Home's binary, YAML config, data and any other service overrides are left alone, as is any frontend directory the patcher didn't create.

There's no timer or background updater on the host. The scheduled GitHub workflow only publishes release files.

## Docker override

The Docker installer writes a single file, `/opt/adguardhome-patcher/compose.patcher.yaml`, generated from the release template with your service name and paths. It's JSON-formatted YAML, so no YAML library is needed.

The override changes the entrypoint to the launcher. Since Compose drops the image's default command when the entrypoint changes, the installer records the container's current image ID and command and the launcher falls back to them when Compose passes no arguments. Your own `command:` still wins.

The installer stores the override's hash, and the container carries a label with a fingerprint of the config. `check` only reports the tooling as current when the file, image ID and label all match. If you change the image or the base command, recreate with only the base Compose file, rerun the Docker installer and apply the override again.

Don't edit the override; put your own settings in the base file. If the override has been changed, the installer and uninstaller leave it in place rather than overwrite or delete it.

## Integrity checks

All downloads go over HTTPS (including redirects), and only the exact asset URLs for your version's release are accepted. Downloads are size-limited and land in a private temp directory. Before installing, the updater checks the published checksum, rejects unsafe paths, links, special files and unexpected entries, verifies every file hash in the manifest and recomputes the frontend revision itself. It never runs anything it downloads.

The launcher only enables `--local-frontend` when `build/VERSION` matches the running binary and `index.html` exists; otherwise AdGuard Home uses its built-in UI.

Nothing changes until you confirm. After you do, an exclusive lock prevents concurrent installs/updates/uninstalls, and the config, binary version and frontend are re-checked in case something changed while the prompt was open. Privileged writes refuse symlinks and paths that aren't root-owned.

## Rollback

1. The new frontend is staged next to the live one and flushed to disk.
2. A journal (`/var/lib/agh-patcher/transaction.json`) is written.
3. The live build is renamed to a backup, then the staged build is renamed into place. Each step is fsynced and recorded in the journal.
4. AdGuard Home is restarted and must report running (and healthy, if Docker has a healthcheck) three checks in a row. The binary version and frontend hashes are verified again.
5. On success the result is recorded in `/var/lib/agh-patcher/last-update.json`, the older backup is cleaned up and the journal is removed. The latest backup is kept.

If anything fails along the way, the previous build is put back (or the stock UI on a first install), AdGuard Home is restarted and the journal is removed. If the rollback itself fails, the journal, backup and staging directories are kept and the error tells you where they are. Rollback only touches the frontend, never AdGuard Home's config or data.

## Interrupted updates

A power cut or `kill -9` during an update can leave the journal behind. `status` will report it and `update` will refuse to run until it's resolved.

The journal records the build, stage and backup paths and the last completed phase. Note that a rename can finish before the phase is updated, so check the paths rather than trusting the phase alone.

1. Stop AdGuard Home.
2. Check the paths and the `phase` in `/var/lib/agh-patcher/transaction.json`:
   - `prepared`, `backup_saved`, `installed` or `rolling_back`: restore the backup to the build path if needed. On a first install, delete any partial build to go back to the stock UI.
   - `committed`: the new build was verified before this was written. Check it and decide whether to keep it or restore the backup.
   - `rolled_back`: check that the restored build is in place.
3. Start AdGuard Home and confirm it's working.
4. Delete the journal and run `sync`. Keep the backup until you're happy.

A leftover `.agh-patcher-stage-*` directory without a journal never touched the live frontend and can be deleted.

These guarantees assume your filesystem honours `fsync` on files and directories. The release build separately tests the official binary with the patched UI; see [Development](development.md).
