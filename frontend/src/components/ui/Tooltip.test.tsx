/**
 * Source-level wiring check for FE-013: HoverTip renders its tip `fixed`
 * inline in the DOM tree (Tooltip.tsx:45 at the time of P-20260919-batch12)
 * rather than through a portal. `position: fixed` still gets clipped by an
 * ancestor that establishes a new containing block (a CSS `transform`,
 * `filter`, `perspective`, `contain`, or `overflow: hidden` — theDAW's own
 * mixer strips, panels and drawers use several of these), so a hover tip
 * inside any such ancestor can be invisible or cut off.
 *
 * HoverTip needs a live browser layout (ancestor stacking/containing
 * contexts) to exercise the clipping bug itself, so per the house pattern
 * for a component-only fix (see audioEditorPanelWiring.test.ts) this asserts
 * the wiring at SOURCE level: the tip must be rendered through
 * `createPortal` to `document.body` so no ancestor can ever clip it.
 *
 * Run: `npx tsx src/components/ui/Tooltip.test.tsx`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Tooltip.tsx'),
  'utf8',
);

assert.match(
  source,
  /import\s*\{[^}]*createPortal[^}]*\}\s*from\s*['"]react-dom['"]/,
  'HoverTip must import createPortal from react-dom to escape ancestor clipping',
);

const hoverTipStart = source.indexOf('export function HoverTip');
assert.ok(hoverTipStart >= 0, 'HoverTip must still be exported');
const infoTipStart = source.indexOf('export function InfoTip');
const hoverTipBody = source.slice(hoverTipStart, infoTipStart > hoverTipStart ? infoTipStart : undefined);

assert.match(
  hoverTipBody,
  /createPortal\(/,
  'HoverTip must render its tip via createPortal(..., document.body) instead of inline in the DOM tree',
);
assert.match(
  hoverTipBody,
  /createPortal\([\s\S]*document\.body/,
  'HoverTip\'s portal target must be document.body so the tip is never clipped by an ancestor stacking/containing context',
);

console.log('Tooltip: all assertions passed');
