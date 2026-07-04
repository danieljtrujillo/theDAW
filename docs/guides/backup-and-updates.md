# Backup and Updates

theDAW keeps two dialogs in the app menu for protecting work and staying current: Backup / Migrate, and Updates. The Backup dialog exports user data to a portable zip and restores it on another install. The Updates dialog compares the installed version against the newest published release and lists older releases. Both dialogs talk to backend modules and run their long operations as background jobs.

## Backup and Migrate

The Backup / Migrate dialog exports user data to a single zip and restores a previously exported zip. It reaches the backend at `/api/backup`.

### What a backup contains

The backend groups user data into three roots. A backup can include any combination of them.

- **Library**: the `data/generations` folder (or the folder named by the `theDAW_GENERATIONS_DIR` environment variable). This holds generated audio, the `library.db` database with entries and genealogy relations, spectrograms, and the per-entry `stems/`, `midi/`, and `notation/` subfolders. In one root this covers library audio, the library database, stems, MIDI, scores, video, and lineage.
- **Projects**: the `theDAW Projects` folder under Documents, where `.tasmo` project files are saved by default.
- **Settings**: the top-level `data/*.json` registries, including `settings.json`, `local_checkpoints.json`, and `recent_projects.json`.

Cache and build folders are always skipped, so a backup never carries `__pycache__`, `.venv`, `venv`, `node_modules`, `.git`, `.cache`, or transcode scratch folders. Previously written backup zips inside a root are skipped as well.

Every zip is written with a `theDAW-backup-manifest.json` entry at its root. The manifest records the app name, the app version read from `pyproject.toml`, the creation timestamp, the included roots, and the total byte count. Import refuses any zip that lacks this manifest.

### Choosing what to export

When the dialog opens it loads the backup manifest from the backend and lists each root with its label and size on disk. Every root starts selected. Clear a checkbox to leave that root out of the export. The size scan runs under a time budget on the backend, so on a large library the reported sizes are lower bounds rather than exact totals.

### Choosing a destination

The Destination field holds the folder that will receive the zip. Type a path directly, or select Choose folder to open the native operating system folder picker. Picking a folder fills the Destination field with the chosen path. Cancelling the picker leaves the field unchanged. If the Destination field is empty, the backend defaults the target to the Documents folder.

### Running an export

Select Export to start the job. The backend enumerates the selected roots, creates a zip named `theDAW-backup-<timestamp>.zip` in the destination folder, writes the manifest, then copies each file. The dialog polls the job and shows a progress bar with a percentage while the export runs. When the job finishes, the dialog shows the full path of the written zip. Export is disabled while another export or import is running, while the Destination field is empty, or when no root is selected.

### Restoring a backup

The Import section restores data from a backup zip.

1. Enter the path to a theDAW backup zip in the Backup zip field.
2. Choose a mode. Merge keeps existing files and writes only files that are not already present. Replace overwrites existing files with the versions from the zip.
3. Select Import.

The backend validates the zip before starting: the file must exist, be a readable zip, and contain a parseable `theDAW-backup-manifest.json`. It then restores each file to the matching root on this install, guarding against paths that would escape a root folder. The dialog polls the import job and shows a progress bar, then confirms when the restore is complete. Import is disabled while a job is running or while the Backup zip field is empty.

### Moving theDAW to another machine

Migration uses export on the old machine and import on the new one.

1. On the old machine, open Backup / Migrate, leave all roots selected, choose a destination folder, and run Export.
2. Copy the resulting `theDAW-backup-<timestamp>.zip` to the new machine.
3. Install theDAW on the new machine.
4. On the new machine, open Backup / Migrate, enter the path to the copied zip, choose Merge for a fresh install or Replace to overwrite existing data, and run Import.

The restored library database, audio, stems, MIDI, scores, video, lineage, projects, and settings land in the same roots on the new install.

## Updates

The Updates dialog reports the installed version against the newest release and lists earlier releases. It reaches the backend at `/api/updates`.

### Checking for updates

On open, the dialog calls the update check. The Version section shows the Installed version and the Latest version side by side, with a Check again control. The installed version comes from `pyproject.toml` on this machine, read once per process. The latest version comes from the GitHub releases of the `gantasmo/theDAW` repository.

The backend picks the newest published stable release as the latest candidate. If the repository has published only prereleases, it falls back to the newest prerelease. Draft releases are never candidates. It then compares the latest tag against the installed version numerically to decide whether an update is available.

The dialog shows one of several states:

- **Up to date**: the installed version matches or exceeds the latest release.
- **Update available**: the latest release is newer. The dialog shows the new version, its publish date, an excerpt of the release notes, and an Open release page control that opens the release in the system browser.
- **Indeterminate**: the version strings could not be compared numerically. The dialog reports the latest published version and leaves the comparison to the reader.
- **Offline**: the release server could not be reached. The dialog shows an amber message and the Check again control becomes Retry.

### The six-hour cache and offline behavior

The latest-release data is cached on disk at `data/updates_check.json` for six hours. A check served from a fresh cache does not touch the network, so startup and repeated checks stay fast. Once the cache is older than six hours, the next check fetches from GitHub and rewrites the cache. Select Check again to force a fresh fetch that bypasses the cache.

A network failure never produces a server error. When offline, the check returns a normal response with no latest version and an error field, and the dialog shows the offline message with a Retry control. The GitHub request uses an eight-second timeout.

### Restoring a previous version

The Previous versions section expands to list up to ten recent releases. The first time it opens, the dialog loads the release list from the backend. Each row shows the release tag, name, and publish date, and opens that release's page in the system browser.

Restoring an older version is release-driven. The backend surfaces release metadata and download-page URLs only. It performs no automatic version switching. To move to a specific version, download that release's installer from its release page and run it. Back up data first from the Backup / Migrate dialog before changing versions.
