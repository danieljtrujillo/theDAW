/**
 * A counter-zoom wrapper must not scale its own size by the layout zoom.
 *
 * The Shell renders under CSS `zoom: var(--layout-zoom)`. A panel that needs
 * unzoomed pointer math (the LEARN graphs) counter-zooms with
 * `zoom: calc(1 / var(--layout-zoom))` and keeps its size at 100%. A wrapper
 * sized `calc(100% * var(--layout-zoom))` covers `zoom` of its panel in each
 * direction below zoom 1 and overflows it above zoom 1, under Chromium's
 * standardized CSS zoom and under its legacy zoom. At zoom 0.85 the LEARN
 * graph canvas measured 1136x476 inside a 1337x560 panel.
 *
 * Every .tsx under src is parsed with the TypeScript compiler. Each object
 * literal that counter-zooms is inspected whole, so a multiplied size is found
 * wherever it sits in that object and however many properties lie between.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lineageFile = join(srcRoot, 'components', 'library', 'LineageModal.tsx');

const tsxFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });

const COUNTER_ZOOM = /^calc\(\s*1\s*\/\s*var\(--layout-zoom/;
const SCALED_BY_ZOOM = /\*\s*var\(--layout-zoom/;
const SIZE_KEYS = new Set(['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'inlineSize', 'blockSize']);

const keyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

/** The text of a string or template initializer; null for anything computed. */
const literalText = (node: ts.Expression): string | null => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return null;
};

interface CounterZoomObject {
  file: string;
  line: number;
  sizes: Map<string, string>;
}

const counterZoomObjects = (file: string): CounterZoomObject[] => {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: CounterZoomObject[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let counterZooms = false;
      const sizes = new Map<string, string>();
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = keyName(prop.name);
        const text = literalText(prop.initializer);
        if (key === null || text === null) continue;
        if (key === 'zoom' && COUNTER_ZOOM.test(text.trim())) counterZooms = true;
        if (SIZE_KEYS.has(key)) sizes.set(key, text);
      }
      if (counterZooms) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({ file, line: line + 1, sizes });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

const counterZoomed = tsxFiles(srcRoot).flatMap(counterZoomObjects);

const offenders = counterZoomed
  .filter((o) => [...o.sizes.values()].some((value) => SCALED_BY_ZOOM.test(value)))
  .map((o) => `${relative(srcRoot, o.file)}:${o.line}`);

assert.deepEqual(
  offenders,
  [],
  'a counter-zoomed wrapper multiplies its size by --layout-zoom, so it fills only ' +
    'part of its panel below zoom 1 and overflows above it: ' +
    offenders.join(', '),
);

const lineage = counterZoomed.filter((o) => o.file === lineageFile);
assert.ok(
  lineage.length > 0,
  'the LEARN graph wrapper no longer counter-zooms; the graph libraries need an effective scale of 1',
);
for (const o of lineage) {
  assert.equal(o.sizes.get('width'), '100%', `LineageModal.tsx:${o.line}: the wrapper must stay 100% wide`);
  assert.equal(o.sizes.get('height'), '100%', `LineageModal.tsx:${o.line}: the wrapper must stay 100% high`);
}

console.log('lineage wrapper guards: ok');
