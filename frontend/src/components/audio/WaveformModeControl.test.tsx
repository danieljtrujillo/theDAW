/**
 * The waveform colour mode's control and legend (PR #207 review).
 *
 *  - The PR put a 14 px mode button (z-40) in the bottom-right corner of every
 *    SemanticWave. On a selected EDIT clip it sat over the right trim handle
 *    and the fade-out grip and took their pointerdown; on a narrow clip it
 *    covered the body. EDIT clips and the clip editor drawer now hide it and
 *    carry the toggle in their toolbar.
 *  - The DJ tab followed the mode with no control and no legend. Its waveform
 *    header now has both.
 *  - The glyph was 8 px; the ruler's labels were 8 px mono.
 *
 * Real components under jsdom for the control and legend; the house
 * source-level check for the placements inside WaveformEditor, AudioEditorPanel
 * and DJView, which need a whole tab to render.
 *
 * Run: `npx tsx src/components/audio/WaveformModeControl.test.tsx`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.localStorage = dom.window.localStorage;
g.IS_REACT_ACT_ENVIRONMENT = true;
class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
(g.window as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
g.ResizeObserver = FakeResizeObserver;
// The waveform itself is not under test: its download never settles, and its
// canvas has no 2D context (jsdom has none to give).
g.fetch = () => new Promise<Response>(() => {});
Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => null });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SemanticWave } = await import('./SemanticWave.tsx');
const { WaveformModeLegend, WaveformModeToggle } = await import('./WaveformModeControl.tsx');
const { useWaveformStyleStore } = await import('../../state/waveformStyleStore.ts');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

const root = createRoot(dom.window.document.getElementById('root') as unknown as Element);
const container = dom.window.document.getElementById('root') as unknown as HTMLElement;

/** Classes that put text under 12 px or in the small mono face. */
const SMALL_TEXT = /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]|font-mono/;

// ── an EDIT clip's waveform holds nothing that can take a pointerdown ─────
// ClipWave renders SemanticWave over the clip body, under the trim handles,
// the fade grips and the inpaint target. Rendered as ClipWave renders it:
{
  await act(async () => {
    root.render(<SemanticWave audioUrl="blob:clip" height={48} viewportStart={0} viewportEnd={1} transparentBg normalize={false} showModeToggle={false} />);
  });
  assert.equal(container.querySelectorAll('button, [tabindex], [role="slider"]').length, 0, 'nothing in the clip waveform takes the pointer or the Tab key');

  const editor = read('WaveformEditor.tsx');
  const clipWave = editor.slice(editor.indexOf('const ClipWave'), editor.indexOf('const clampFrac'));
  assert.match(clipWave, /<SemanticWave[^>]*showModeToggle=\{false\}/, 'ClipWave hides the corner toggle');
  assert.match(editor, /<WaveformModeToggle variant="toolbar" \/>/, 'EDIT carries the toggle in its toolbar');
}

// ── the clip editor drawer: same, its toggle in the breadcrumb bar ─────────
{
  const panel = read('../layout/AudioEditorPanel.tsx');
  assert.match(panel, /<SemanticWave[\s\S]*?showModeToggle=\{false\}[\s\S]*?\/>/, 'the drawer waveform hides the corner toggle');
  assert.match(panel, /<WaveformModeToggle variant="toolbar" \/>/, 'the drawer carries the toggle in its toolbar');
}

// ── every other surface keeps its corner toggle, readable ──────────────────
{
  await act(async () => {
    root.render(<SemanticWave audioUrl="blob:footer" height={34} />);
  });
  const corner = container.querySelector('button');
  assert.ok(corner, 'a plain SemanticWave keeps its corner toggle');
  assert.match(corner.className, /\btext-xs\b/, '12 px');
  assert.match(corner.className, /\bfont-bold\b/, 'bold');
  assert.match(corner.className, /\bfont-sans\b/, 'sans');
  assert.doesNotMatch(corner.className, SMALL_TEXT);
}

// ── the DJ tab: a toggle and a legend over the deck lanes ─────────────────
// The sequence: the decks are loaded, the user picks a mode from the DJ tab's
// own toggle, and the legend over the lanes says what the colours now mean.
{
  const dj = read('../../views/DJView.tsx');
  const hero = dj.slice(dj.indexOf("pinned('hero'"), dj.indexOf("pinned('sampler'"));
  assert.match(hero, /<WaveformModeToggle variant="toolbar"/, 'the DJ waveforms have a toggle');
  assert.match(hero, /<WaveformModeLegend/, 'and a legend');

  useWaveformStyleStore.setState({ mode: 'semantic' });
  await act(async () => {
    root.render(
      <div>
        <WaveformModeToggle variant="toolbar" />
        <WaveformModeLegend />
      </div>,
    );
  });
  const button = container.querySelector('button') as HTMLButtonElement;
  const legendText = () => (container.querySelector('ul') as HTMLUListElement).textContent ?? '';
  assert.match(legendText(), /Red: beat/);
  assert.match(legendText(), /Green: mids 420 Hz–1\.7 kHz/);
  // The toolbar toggle shows the mode's glyph only; its accessible name and
  // tooltip start with the mode's name and carry the legend.
  const glyph = () => [...button.querySelectorAll('span')].map((el) => el.textContent ?? '').join('');
  const nameStartsWith = (name: string) => {
    assert.ok((button.getAttribute('aria-label') ?? '').startsWith(name), `"${button.getAttribute('aria-label')}" starts with "${name}"`);
    assert.equal(button.getAttribute('title'), button.getAttribute('aria-label'), 'the tooltip says what the name says');
  };
  assert.equal(glyph(), '●');
  nameStartsWith('Wave: Color.');
  assert.match(button.getAttribute('aria-label') ?? '', /Red: beat/, 'the name still carries the legend');

  await act(async () => {
    button.click(); // plain
  });
  await act(async () => {
    button.click(); // clipping
  });
  assert.equal(useWaveformStyleStore.getState().mode, 'clipping');
  assert.match(legendText(), /Red: clipped/);
  assert.doesNotMatch(legendText(), /beat/i, 'the clipping legend never calls red a beat');
  assert.equal(glyph(), '!');
  nameStartsWith('Wave: Clipping.');
  assert.match(button.getAttribute('aria-label') ?? '', /Red: clipped/);

  for (const el of container.querySelectorAll('button, ul, li, span')) {
    assert.doesNotMatch((el as HTMLElement).className ?? '', SMALL_TEXT, `no small text in the control: ${(el as HTMLElement).className}`);
  }
  const list = container.querySelector('ul') as HTMLUListElement;
  const labelledBy = list.getAttribute('aria-labelledby');
  assert.ok(labelledBy && dom.window.document.getElementById(labelledBy), 'the legend list is labelled');
}

// ── the EDIT ruler's labels are bold 12 px sans ────────────────────────────
{
  const editor = read('WaveformEditor.tsx');
  // Time labels, bar numbers and the time-range readout.
  const ruler = editor.slice(editor.indexOf('{renderRuler.map('), editor.indexOf('{/* Edit cursor on the ruler'));
  const spans = ruler.match(/<span className=\{?[`"][^`"]*[`"]/g) ?? [];
  assert.equal(spans.length, 3, `found the ruler's three labels, got ${spans.length}`);
  for (const span of spans) {
    assert.match(span, /\btext-xs\b/, `ruler label is 12 px: ${span}`);
    assert.match(span, /\bfont-bold\b/, `ruler label is bold: ${span}`);
    assert.doesNotMatch(span, SMALL_TEXT, `ruler label: ${span}`);
  }
}

await act(async () => {
  root.unmount();
});
console.log('WaveformModeControl.test.tsx: ok');
