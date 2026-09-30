# POWER MODE export tooling

Run from the Foundry application directory with explicitly selected source,
texture and output paths:

```text
npx tsx --tsconfig scripts/tsconfig.export.json scripts/export-powermode.mts --session <project.json> --textures <directory> --out <new-directory> [--name <name>]
```

`scripts/tsconfig.export.json` maps the browser-only `file-saver` import to the
existing headless shim. The bundle loader also selects this configuration
internally, relative to its source file, so the compatibility command
`npx tsx scripts/export-powermode.mts` remains available with the same required
input flags. Use `--help` to print usage without reading source or texture files.
Importing the entry point performs no export.

All referenced textures must exist. Missing required textures cause an error
before bundle building, output-directory creation or file writes. Supply the
listed files in the `--textures` directory and retry. There is no option to
silently produce incomplete bundles. Pure `preparePowerMode` callers can still
inspect its `missingTextures` list without writing anything.

Successful exports retain the raw project text and produce the project JSON,
GAN manifest, `.gan` package and VST3 data bundle. Existing output files are
never overwritten; choose a new output directory when exporting again.

Synthetic checks, without exporting or reading an actual session:

```text
npx tsx --test scripts/power-mode/prepare.test.mts scripts/power-mode/cli.test.mts
npx tsc --noEmit --project scripts/tsconfig.export.json
```
