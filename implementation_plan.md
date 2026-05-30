# Implementation Plan

[Overview]
Implement a documentation-audit and screenshot-refresh workflow that discovers app features missing from documentation, updates the canonical docs, and generates polished full-scene plus targeted cropped screenshots using Playwright for real in-app DAW interactions.

This implementation will formalize a repeatable process across three assets that already exist but are currently fragmented: the canonical functional documentation (`docs/USER_GUIDE.md`), screenshot automation (`scripts/screenshots/capture.ts` and `scripts/screenshots/take-screenshots.mjs`), and screenshot indexes/manifests (`docs/screenshots/README.md`, `docs/UI/llm-screenshots/INDEX.md`). The key gap is not lack of tooling, but lack of a deterministic “feature coverage” pass that checks what is implemented versus what is documented, with explicit outputs and traceability.

The approach is to establish a feature-inventory source generated from repo code + repomix context (`repomix-output.md`), compare that inventory against documentation sections, produce a machine-readable “coverage delta” report, and then apply doc updates in the canonical guide and supporting UI docs. In parallel, screenshot capture is expanded from static scene snaps into scenario-driven captures that include cropped focus regions where needed (e.g., control clusters, context menus, DAW subpanels), while allowing one screenshot to support multiple referenced features in docs tables.

The final state will support: (1) easy regeneration, (2) consistency between in-app docs modal and canonical docs, (3) maintainable screenshot references, and (4) improved presentation quality for docs assets (via Magic-assisted docs formatting/visual framing only, not app UI changes).

[Types]
Add explicit metadata and report types for feature/doc/screenshot coverage and capture outputs.

Detailed type definitions to introduce in TypeScript automation scripts (or adjacent utility module under `scripts/screenshots/`):

- `FeatureDescriptor`
  - `id: string` (stable slug, e.g., `waveform-editor-inpaint-review`)
  - `name: string` (human label)
  - `domain: 'create' | 'edit' | 'train' | 'library' | 'daw' | 'assistant' | 'settings' | 'chimera' | 'vj' | 'backend-module'`
  - `sourcePaths: string[]` (code paths proving implementation)
  - `evidence: string[]` (symbols/selectors/endpoints/signatures)
  - `status: 'implemented' | 'stubbed' | 'experimental'`
  - Validation rule: `id` unique, `sourcePaths.length >= 1`

- `DocCoverageEntry`
  - `featureId: string`
  - `docAnchors: string[]` (e.g., `#10-waveform-editor`, `#16-backend-api-reference`)
  - `coverage: 'documented' | 'partial' | 'missing'`
  - `notes: string`
  - Validation rule: `featureId` must resolve to `FeatureDescriptor.id`

- `ScreenshotSpec`
  - `sceneId: string` (existing SCENE key or new)
  - `outputFile: string`
  - `viewport: { width: number; height: number }`
  - `captureMode: 'full' | 'crop' | 'full+crop'`
  - `cropRegions?: Array<{ id: string; x: number; y: number; width: number; height: number; purpose: string }>`
  - `featureRefs: string[]` (which features it documents; supports many-to-one)
  - Validation rule: crop rectangles within viewport bounds

- `ScreenshotManifestEntry`
  - `file: string`
  - `label: string`
  - `features: string[]`
  - `docsSections: string[]`
  - `kind: 'full' | 'crop'`
  - `sourceScene: string`

- `CoverageReport`
  - `generatedAt: string` (ISO timestamp)
  - `repoRevision: string` (git SHA)
  - `features: FeatureDescriptor[]`
  - `coverage: DocCoverageEntry[]`
  - `missingFeatureIds: string[]`
  - `partialFeatureIds: string[]`
  - `screenshotSpecs: ScreenshotSpec[]`

[Files]
Create a planning-driven documentation and screenshot audit pipeline with explicit file updates.

Detailed breakdown:

- New files to be created:
  - `docs/plans/implementation-feature-doc-screenshot-audit.md`
    - Purpose: durable technical plan/execution checklist for maintainers.
  - `docs/reports/feature-doc-coverage-report.md`
    - Purpose: human-readable output listing missing/partial documented features.
  - `docs/reports/feature-doc-coverage.json`
    - Purpose: machine-readable source for docs updates and screenshot mapping.
  - `scripts/screenshots/specs.ts`
    - Purpose: centralized scene/crop/feature mapping specs.
  - `scripts/screenshots/featureCoverage.ts`
    - Purpose: build feature inventory + doc coverage comparison report.

- Existing files to be modified:
  - `docs/USER_GUIDE.md`
    - Add missing feature sections and/or expand partial sections.
    - Add screenshot references that can be reused by multiple features.
    - Add “last audited” metadata block.
  - `frontend/public/USER_GUIDE.md`
    - Synced from canonical guide via existing regenerate flow.
  - `docs/screenshots/README.md`
    - Expand with crop asset rules, naming convention, and mapping model.
  - `docs/UI/llm-screenshots/INDEX.md`
    - Add feature IDs and multi-reference mapping to support one-to-many screenshot usage.
  - `scripts/screenshots/capture.ts`
    - Add crop capture utilities and per-scene crop definitions.
    - Preserve current full-scene captures; extend with targeted crops.
  - `scripts/screenshots/take-screenshots.mjs`
    - Align with scene spec centralization or deprecate in favor of one canonical runner.
  - `scripts/regenerate-docs.ps1`
  - `scripts/regenerate-docs.sh`
    - Ensure docs sync + screenshot regeneration + report generation sequence.

- Files to be deleted or moved:
  - No deletions required initially.
  - Optional future consolidation: retire duplicate screenshot runner after compatibility pass.

- Configuration updates:
  - `.gitignore`
    - Ensure repomix artifacts remain ignored if regenerated variants are produced.
  - Optional npm script additions in `frontend/package.json` (or root package task via npm prefix pattern) for coverage report generation.

[Functions]
Add and modify automation functions to support feature coverage detection, documentation synchronization, and cropped screenshot capture.

Detailed breakdown:

- New functions:
  - `collectFeatureDescriptors(): Promise<FeatureDescriptor[]>`
    - File: `scripts/screenshots/featureCoverage.ts`
    - Purpose: parse curated code/doc evidence into canonical feature descriptors.
  - `mapFeatureCoverage(features, userGuideText): DocCoverageEntry[]`
    - File: `scripts/screenshots/featureCoverage.ts`
    - Purpose: detect documented vs partial vs missing coverage.
  - `emitCoverageReport(report: CoverageReport): Promise<void>`
    - File: `scripts/screenshots/featureCoverage.ts`
    - Purpose: write md/json report artifacts.
  - `captureCroppedRegions(page, spec: ScreenshotSpec): Promise<void>`
    - File: `scripts/screenshots/capture.ts`
    - Purpose: generate region screenshots from a known viewport.
  - `buildScreenshotManifestEntries(specs, generatedFiles): ScreenshotManifestEntry[]`
    - File: `scripts/screenshots/specs.ts` (or helper module)
    - Purpose: generate consistent manifest rows for docs.

- Modified functions:
  - `snap(page, name)`
    - File: `scripts/screenshots/capture.ts`
    - Change: support optional clip/region options and metadata emission.
  - Each scene `run(page)` in `SCENES`
    - File: `scripts/screenshots/capture.ts`
    - Change: attach feature references and optional crop capture actions.
  - Docs regeneration pipeline entry in PowerShell/Shell scripts
    - Files: `scripts/regenerate-docs.ps1`, `scripts/regenerate-docs.sh`
    - Change: call coverage report generation before screenshot pass and doc sync completion.

- Removed functions:
  - None required in initial implementation.

[Classes]
No application runtime classes are required; this plan is function- and data-spec-driven for docs tooling.

Detailed breakdown:

- New classes:
  - None planned.

- Modified classes:
  - None planned.

- Removed classes:
  - None planned.

[Dependencies]
Leverage existing dependencies; only add packages if unavoidable for image post-processing and manifest generation.

Dependency details:

- Existing dependencies already sufficient for baseline:
  - `playwright` (already in `frontend/devDependencies`)
  - `tsx` (already present for script execution)

- Optional additions (only if needed after implementation spike):
  - `sharp` (for advanced crop/annotation post-processing beyond Playwright clip screenshots)
  - If added, lock exact version in `frontend/package-lock.json` and document usage.

- No backend/runtime dependency changes expected.

[Implementation Order]
Implement in a coverage-first sequence, then screenshot enhancements, then docs polish and regeneration integration.

1. Build feature inventory + coverage comparison tooling and generate baseline report from tracked repo + `repomix-output.md` context.
2. Define screenshot scene/crop specs with stable feature references and naming conventions.
3. Extend Playwright capture pipeline to output full + cropped assets and updated manifest metadata.
4. Update `docs/USER_GUIDE.md` with missing/partial feature documentation using coverage report as source-of-truth checklist.
5. Sync to `frontend/public/USER_GUIDE.md`, validate in `DocsModal`, and ensure markdown anchors/reference links are consistent.
6. Apply Magic-assisted documentation presentation refinements (layout/callout structure, screenshot table quality) in docs artifacts only.
7. Integrate end-to-end regeneration into docs scripts and produce final reports/screenshots.

task_progress Items:
- [ ] Step 1: Generate feature inventory and feature-vs-doc coverage report (including repomix-informed scan)
- [ ] Step 2: Define canonical screenshot/crop spec mapped to feature IDs (many features may map to one screenshot)
- [ ] Step 3: Implement Playwright capture updates for full-scene and targeted crop outputs
- [ ] Step 4: Update USER_GUIDE and related docs to cover all missing/partial features
- [ ] Step 5: Sync in-app docs copy and verify DocsModal rendering integrity
- [ ] Step 6: Apply Magic-based documentation presentation polish (docs assets only)
- [ ] Step 7: Wire regeneration scripts and produce final screenshot + coverage artifacts