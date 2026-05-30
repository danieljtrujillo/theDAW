import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FEATURE_DESCRIPTORS,
  SCREENSHOT_SPECS,
  buildScreenshotManifestEntries,
  validateScreenshotSpecs,
  type CoverageReport,
  type DocCoverageEntry,
  type FeatureDescriptor,
} from './specs.js';

const REPO_ROOT = path.resolve(process.cwd().endsWith('frontend') ? '..' : '.');
const GUIDE_PATH = path.join(REPO_ROOT, 'docs', 'USER_GUIDE.md');
const REPORT_DIR = path.join(REPO_ROOT, 'docs', 'reports');
const JSON_REPORT = path.join(REPORT_DIR, 'feature-doc-coverage.json');
const MD_REPORT = path.join(REPORT_DIR, 'feature-doc-coverage-report.md');
const REPOMIX_PATH = path.join(REPO_ROOT, 'repomix-output.md');

const slugify = (text: string): string => text
  .toLowerCase()
  .replace(/[`*_[\]()]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

function repoRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function isTracked(relativePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relativePath], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function extractAnchors(markdown: string): Array<{ heading: string; anchor: string; body: string }> {
  const matches = [...markdown.matchAll(/^(#{2,4})\s+(.+)$/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const heading = match[2].trim();
    return {
      heading,
      anchor: `#${slugify(heading)}`,
      body: markdown.slice(start, end),
    };
  });
}

export async function collectFeatureDescriptors(): Promise<FeatureDescriptor[]> {
  const seen = new Set<string>();
  for (const feature of FEATURE_DESCRIPTORS) {
    if (seen.has(feature.id)) throw new Error(`Duplicate feature id: ${feature.id}`);
    seen.add(feature.id);
    if (feature.sourcePaths.length === 0) throw new Error(`Feature ${feature.id} has no source paths`);
  }
  return FEATURE_DESCRIPTORS;
}

export function mapFeatureCoverage(features: FeatureDescriptor[], userGuideText: string): DocCoverageEntry[] {
  const anchors = extractAnchors(userGuideText);
  const lowerGuide = userGuideText.toLowerCase();
  return features.map((feature) => {
    const matches = feature.docSearchTerms.filter((term) => lowerGuide.includes(term.toLowerCase()));
    const docAnchors = anchors
      .filter((section) => feature.docSearchTerms.some((term) => `${section.heading}\n${section.body}`.toLowerCase().includes(term.toLowerCase())))
      .map((section) => section.anchor);
    const coverage = matches.length >= Math.max(2, Math.ceil(feature.docSearchTerms.length * 0.35))
      ? 'documented'
      : matches.length > 0
        ? 'partial'
        : 'missing';
    return {
      featureId: feature.id,
      docAnchors: [...new Set(docAnchors)],
      coverage,
      notes: coverage === 'documented'
        ? `Matched ${matches.length}/${feature.docSearchTerms.length} guide terms.`
        : coverage === 'partial'
          ? `Only matched ${matches.length}/${feature.docSearchTerms.length} guide terms: ${matches.join(', ')}`
          : `No guide terms found. Add coverage for: ${feature.docSearchTerms.slice(0, 4).join(', ')}`,
    };
  });
}

function toMarkdown(report: CoverageReport): string {
  const byId = new Map(report.features.map((f) => [f.id, f]));
  const documentedCount = report.coverage.filter((entry) => entry.coverage === 'documented').length;
  const coveragePercent = report.features.length === 0
    ? 100
    : Math.round((documentedCount / report.features.length) * 100);
  const rows = report.coverage.map((entry) => {
    const feature = byId.get(entry.featureId);
    return `| \`${entry.featureId}\` | ${feature?.name ?? entry.featureId} | ${feature?.domain ?? ''} | ${feature?.status ?? ''} | **${entry.coverage}** | ${entry.docAnchors.join('<br>') || '—'} | ${entry.notes.replace(/\|/g, '\\|')} |`;
  }).join('\n');

  const screenshotRows = report.screenshotManifest.map((entry) => (
    `| \`${entry.file}\` | ${entry.kind} | ${entry.sourceScene} | ${entry.features.map((f) => `\`${f}\``).join('<br>')} | ${entry.docsSections.join('<br>')} |`
  )).join('\n');

  return `# Feature Documentation Coverage Report\n\n` +
    `> [!NOTE]\n` +
    `> Generated: ${report.generatedAt} · Git revision: \`${report.repoRevision}\` · Repomix tracked: **${report.repomixContext.tracked ? 'yes' : 'no'}**\n\n` +
    `## Audit Dashboard\n\n` +
    `| Metric | Value |\n` +
    `|---|---:|\n` +
    `| Documentation coverage | **${coveragePercent}%** |\n` +
    `| Features inventoried | **${report.features.length}** |\n` +
    `| Documented features | **${documentedCount}** |\n` +
    `| Missing docs | **${report.missingFeatureIds.length}** |\n` +
    `| Partial docs | **${report.partialFeatureIds.length}** |\n` +
    `| Full screenshot scenes | **${report.screenshotSpecs.length}** |\n` +
    `| Cropped screenshot assets | **${report.screenshotManifest.filter((e) => e.kind === 'crop').length}** |\n\n` +
    `> [!IMPORTANT]\n` +
    `> Repomix context: ${report.repomixContext.present ? `present at \`${report.repomixContext.path}\`` : 'not present'}; tracked=${report.repomixContext.tracked}. ${report.repomixContext.note}\n\n` +
    `## Coverage Matrix\n\n` +
    `| Feature ID | Feature | Domain | Status | Coverage | Anchors | Notes |\n` +
    `|---|---|---|---|---|---|---|\n` +
    `${rows}\n\n` +
    `## Screenshot Mapping\n\n` +
    `| File | Kind | Source scene | Feature IDs | Docs sections |\n` +
    `|---|---|---|---|---|\n` +
    `${screenshotRows}\n\n` +
    `## Required Documentation Follow-up\n\n` +
    (report.missingFeatureIds.length === 0 && report.partialFeatureIds.length === 0
      ? `> [!TIP]\n> Coverage is currently clean. Keep it that way by updating \`scripts/screenshots/specs.ts\`, \`docs/USER_GUIDE.md\`, and screenshot mappings in the same change whenever a feature changes.\n`
      : `Patch \`docs/USER_GUIDE.md\` for every feature marked missing or partial. One screenshot may intentionally cover multiple feature IDs; use the screenshot mapping above rather than duplicating captures.\n`);
}

export async function emitCoverageReport(report: CoverageReport): Promise<void> {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(JSON_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(MD_REPORT, toMarkdown(report), 'utf8');
}

export async function buildCoverageReport(): Promise<CoverageReport> {
  validateScreenshotSpecs();
  const guide = await fs.readFile(GUIDE_PATH, 'utf8');
  const features = await collectFeatureDescriptors();
  const coverage = mapFeatureCoverage(features, guide);
  const missingFeatureIds = coverage.filter((entry) => entry.coverage === 'missing').map((entry) => entry.featureId);
  const partialFeatureIds = coverage.filter((entry) => entry.coverage === 'partial').map((entry) => entry.featureId);
  const repomixPresent = await fs.access(REPOMIX_PATH).then(() => true).catch(() => false);
  return {
    generatedAt: new Date().toISOString(),
    repoRevision: repoRevision(),
    repomixContext: {
      path: 'repomix-output.md',
      present: repomixPresent,
      tracked: isTracked('repomix-output.md'),
      note: repomixPresent
        ? 'Used as local analysis context only. It is intentionally gitignored and must not be staged.'
        : 'Repomix context was not present for this run.',
    },
    features,
    coverage,
    missingFeatureIds,
    partialFeatureIds,
    screenshotSpecs: SCREENSHOT_SPECS,
    screenshotManifest: buildScreenshotManifestEntries(),
  };
}

async function main(): Promise<void> {
  const report = await buildCoverageReport();
  await emitCoverageReport(report);
  console.log(`[coverage] wrote ${path.relative(REPO_ROOT, JSON_REPORT)}`);
  console.log(`[coverage] wrote ${path.relative(REPO_ROOT, MD_REPORT)}`);
  console.log(`[coverage] ${report.features.length} features, ${report.missingFeatureIds.length} missing, ${report.partialFeatureIds.length} partial`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});