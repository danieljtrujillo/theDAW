/**
 * DJSemanticWaveform — a long EDIT clip at deep zoom draws (PR #207 review).
 *
 * ClipWave sizes the waveform's wrapper to the clip: a 220 s clip at
 * 400 px/s is 88,000 CSS px wide, 110,000 device px at dpr 1.25. The PR still
 * sized the visible canvas to that whole wrapper. A browser refuses a
 * backing store that wide, so the clip stayed a blank rectangle; below the
 * limit the PR drew into an 8,192 px render and stretched it.
 *
 * The sequence replayed here, through the real component under jsdom: the
 * clip mounts with its first 1,600 px on screen, the audio decodes and is
 * analysed, the lane draws; then the timeline scrolls 40,000 px along and
 * the lane follows. The canvas stands in for a browser's: a backing store
 * wider than 32,767 px (or over 268 M px) gets no 2D context, which is how a
 * refused canvas stays blank.
 *
 * Run: `npx tsx src/components/audio/DJSemanticWaveform.longclip.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
const win = dom.window;
const winGlobals = win as unknown as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.requestAnimationFrame = win.requestAnimationFrame.bind(win);
g.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1920 });
Object.defineProperty(win, 'devicePixelRatio', { configurable: true, value: 1.25 });

let latestResize: (() => void) | null = null;
class FakeResizeObserver {
  constructor(cb: () => void) {
    latestResize = cb;
  }
  observe(): void {}
  disconnect(): void {}
}
winGlobals.ResizeObserver = FakeResizeObserver;
g.ResizeObserver = FakeResizeObserver;

// ── layout: the clip wrapper is 88,000 px, the timeline scroller 1,600 px ──
const CLIP_PX = 220 * 400;
const SCROLLER_PX = 1600;
const HEIGHT = 64;
let clipLeft = 0;
const rect = (left: number, width: number, height = HEIGHT) =>
  ({ left, right: left + width, width, top: 0, bottom: height, height, x: left, y: 0, toJSON() {} }) as DOMRect;
/** The component's own wrapper: the element whose child is the canvas. */
const isLane = (el: Element) => el.firstElementChild?.tagName === 'CANVAS';
Object.defineProperty(win.Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value(this: Element) {
    if (isLane(this)) return rect(clipLeft, CLIP_PX);
    if ((this as HTMLElement).dataset?.scroller === '1') return rect(0, SCROLLER_PX);
    return rect(0, 1920, 1080);
  },
});
Object.defineProperty(win.Element.prototype, 'clientWidth', {
  configurable: true,
  get(this: Element) {
    return isLane(this) ? CLIP_PX : 1920;
  },
});

// ── the canvas: a browser's size limit, and a record of what was drawn ─────
const BROWSER_MAX_SIDE = 32767;
const BROWSER_MAX_AREA = 268_435_456;
type Drawn = { fills: number[]; images: Array<{ sw: number; dw: number }> };
const drawn = new WeakMap<HTMLCanvasElement, Drawn>();
Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value(this: HTMLCanvasElement) {
    if (this.width > BROWSER_MAX_SIDE || this.width * this.height > BROWSER_MAX_AREA) return null;
    const record: Drawn = drawn.get(this) ?? { fills: [], images: [] };
    drawn.set(this, record);
    let scale = 1;
    return {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: '',
      textBaseline: '',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      setTransform(a: number) {
        scale = a;
      },
      clearRect() {},
      strokeRect() {},
      fillText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      fillRect(x: number, _y: number, w: number) {
        // Body columns are 1 CSS px wide; guides and backgrounds span the lane.
        if (w === 1) record.fills.push(x);
      },
      drawImage(_img: unknown, _sx: number, _sy: number, sw: number, _sh: number, _dx: number, _dy: number, dw: number) {
        record.images.push({ sw, dw: dw * scale });
      },
    };
  },
});

// ── audio: a 220 s clip ────────────────────────────────────────────────────
g.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;
class FakeOfflineAudioContext {
  sampleRate = 44100;
  async decodeAudioData(): Promise<AudioBuffer> {
    const rate = 200;
    const length = 220 * rate;
    const data = new Float32Array(length);
    for (let i = 0; i < length; i += 1) data[i] = 0.5 * Math.sin(i * 0.37);
    return { numberOfChannels: 1, length, sampleRate: rate, duration: 220, getChannelData: () => data } as unknown as AudioBuffer;
  }
}
winGlobals.OfflineAudioContext = FakeOfflineAudioContext;
g.OfflineAudioContext = FakeOfflineAudioContext;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DJSemanticWaveform } = await import('./DJSemanticWaveform.tsx');

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const root = createRoot(win.document.getElementById('root') as unknown as Element);
await act(async () => {
  root.render(
    <div data-scroller="1" style={{ overflowX: 'auto', width: SCROLLER_PX }}>
      <div style={{ width: CLIP_PX }}>
        <DJSemanticWaveform audioUrl="blob:long-clip" height={HEIGHT} transparentBg normalize={false} />
      </div>
    </div>,
  );
});
await settle();
await act(async () => {
  latestResize?.();
});
await settle();

const canvas = win.document.querySelector('canvas') as HTMLCanvasElement;
assert.ok(canvas, 'the lane has a canvas');

/** The canvas's CSS placement inside the 88,000 px wrapper. */
function placement(): { left: number; width: number } {
  return { left: parseFloat(canvas.style.left || '0'), width: parseFloat(canvas.style.width || String(CLIP_PX)) };
}

// ── mounted with the clip's start on screen ────────────────────────────────
{
  const box = placement();
  assert.ok(canvas.width <= 16384, `the visible canvas is at most 16,384 device px, got ${canvas.width}`);
  assert.ok(canvas.width <= BROWSER_MAX_SIDE, 'a browser backs it');
  assert.ok(box.left <= 0 && box.left + box.width >= SCROLLER_PX, `it covers the on-screen 0..${SCROLLER_PX} px, got ${JSON.stringify(box)}`);
  const record = drawn.get(canvas);
  assert.ok(record && record.fills.length > 0, 'the clip draws: it is not blank');
  assert.equal(record.images.length, 0, 'drawn directly at full resolution, nothing stretched');
  const columns = new Set(record.fills.map((x) => Math.floor(x)));
  assert.ok(columns.size >= Math.floor(box.width) - 1, `one column per CSS px of the canvas, got ${columns.size} for ${box.width}`);
  assert.equal(Math.round(canvas.width), Math.round(box.width * 1.25), 'backed at dpr 1.25 with no resampling');
}

// ── the timeline scrolls 40,000 px along the clip ──────────────────────────
{
  drawn.delete(canvas);
  clipLeft = -40_000;
  await act(async () => {
    win.dispatchEvent(new win.Event('scroll'));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await settle();
  const box = placement();
  assert.ok(box.left <= 40_000 && box.left + box.width >= 40_000 + SCROLLER_PX, `the canvas follows the scroll, got ${JSON.stringify(box)}`);
  assert.ok(canvas.width <= 16384);
  // The lane's viewport moved at a steady zoom, so it may render the window
  // around it offscreen and blit that: either way, device px for device px.
  const record = drawn.get(canvas);
  assert.ok(record && (record.fills.length > 0 || record.images.length > 0), 'the newly visible part draws');
  for (const image of record.images) {
    assert.ok(Math.abs(image.sw - image.dw) <= 1, `a blit is 1:1, never stretched: ${image.sw} source px onto ${image.dw} device px`);
  }
}

await act(async () => {
  root.unmount();
});
console.log('DJSemanticWaveform.longclip.test.tsx: ok');
