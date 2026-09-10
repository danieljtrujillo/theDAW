/**
 * The whole lyric as one web.
 *
 * The sheet draws findings ON the words, which is the right place to read
 * them and the wrong place to see the SHAPE: a callback across three verses
 * is a wire that leaves the top of the screen. So this is the other view —
 * the lyric collapsed to one node per line down a spine, every connection in
 * it drawn as an arc across the gap, and nothing else on the page.
 *
 * Two layouts, because the two questions are different:
 *   - ARC lays the lines down a vertical spine in reading order and bows each
 *     connection out to the side. Distance is preserved, so a callback across
 *     forty lines is a forty-line arc and looks like one.
 *   - RING closes that spine into a circle and draws the connections as
 *     chords. Distance stops being legible and DENSITY starts being: a song
 *     whose chorus answers every verse is a starburst.
 *
 * It renders to SVG and nothing else — no canvas, no layout library — so the
 * export is the same picture the screen is showing, not a re-draw of it, and
 * the PNG is that SVG rasterised at whatever scale is asked for.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import {
  FAMILY_RGB,
  groupInk,
  inkAt,
  type SheetModel,
  type SheetRow,
} from '../../../state/lyricAnalysisStore';
import type { Device, DeviceFamily } from '../../../lib/lyricAnalysisClient';

export type WebLayout = 'arc' | 'ring';

/** Everything the web can draw, as families. A wire is only as interesting as
 *  the family it belongs to, and a writer reading the rhyme web does not want
 *  four hundred alliteration threads under it. */
const WEB_FAMILIES: DeviceFamily[] = ['rhyme', 'sound', 'repetition', 'meaning'];

const FAMILY_WORDS: Record<DeviceFamily, string> = {
  rhyme: 'rhyme',
  sound: 'sound',
  repetition: 'repetition',
  structure: 'structure',
  meaning: 'meaning',
};

/** Canvas size. Fixed rather than measured, so the exported file is the same
 *  picture at any window size and a screenshot of it is reproducible. */
const W = 1000;
const PAD_TOP = 64;
const PAD_BOTTOM = 40;
/** How far an arc may bow off the spine, and where the widest one stops.
 *
 *  Every arc bows LEFT and the words hang off the spine to the RIGHT, so an
 *  arc and a line of the lyric can never be drawn over each other. Where the
 *  spine actually sits is computed per lyric (`WebModel.spineX`): a song whose
 *  longest connection reaches four lines does not need half the page kept
 *  clear for an arc that is never drawn.
 */
const MAX_BOW = 480;
/** Left edge the widest arc is allowed to reach. */
const BOW_LIMIT = 64;
/** The narrowest the arc field may be, so two short reaches still separate. */
const MIN_FIELD = 150;
/** Rows any denser than this get a thinner node so the spine stays readable. */
const TIGHT_ROWS = 90;

export interface WebEdge {
  id: string;
  group: string;
  deviceId: string;
  kind: string;
  label: string;
  family: DeviceFamily;
  rgb: string;
  confidence: number;
  from: number;
  to: number;
  /** Reading-order distance in lines: what the arc's height encodes. */
  span: number;
}

export interface WebNode {
  line: number;
  /** Position down the spine, 0..1. */
  t: number;
  letter: string;
  classIndex: number;
  section: string;
  text: string;
  syllables: number;
  degree: number;
}

export interface WebModel {
  nodes: WebNode[];
  edges: WebEdge[];
  /** Where the spine of the ARC layout sits, from the widest arc this lyric
   *  actually has. Everything left of it is the arc field; everything right of
   *  it is the words. */
  spineX: number;
  /** Line number -> index into `nodes`, for the edge endpoints. */
  indexOf: Map<number, number>;
  sections: Array<{ name: string; from: number; to: number }>;
  height: number;
  /** Edges the cap dropped, named rather than silently missing. */
  overflow: number;
}

const MAX_EDGES = 1200;

/**
 * The web's own model: one node per lyric line, one edge per connection.
 *
 * Edges come from the devices rather than from the sheet's wiring, because
 * the sheet's wiring is capped and scoped for readability over the words and
 * this view exists to show everything. A device with N places in it becomes
 * N-1 edges along its own chain — the same chain the sheet draws when the
 * finding is open, so the two pictures agree.
 */
export function buildWebModel(
  rows: readonly SheetRow[],
  devices: readonly Device[],
  families: ReadonlySet<DeviceFamily>,
  minSpan: number,
): WebModel {
  const nodes: WebNode[] = [];
  const indexOf = new Map<number, number>();
  for (const row of rows) {
    if (row.blank || row.kind === 'marker') continue;
    indexOf.set(row.line, nodes.length);
    nodes.push({
      line: row.line,
      t: 0,
      letter: row.letter,
      classIndex: row.classIndex,
      section: row.section,
      text: row.text,
      syllables: row.syllables,
      degree: 0,
    });
  }
  const n = nodes.length;
  nodes.forEach((node, i) => {
    node.t = n > 1 ? i / (n - 1) : 0;
  });

  const edges: WebEdge[] = [];
  let overflow = 0;
  for (const device of devices) {
    const family = device.family as DeviceFamily;
    if (!families.has(family)) continue;
    const lines: number[] = [];
    for (const span of device.spans) {
      const at = indexOf.get(span.line);
      if (at === undefined) continue;
      if (lines[lines.length - 1] !== at) lines.push(at);
    }
    if (lines.length < 2) continue;
    const rgb = family === 'rhyme' ? groupInk(device.group || device.id).rgb : FAMILY_RGB[family];
    for (let k = 1; k < lines.length; k += 1) {
      const from = Math.min(lines[k - 1], lines[k]);
      const to = Math.max(lines[k - 1], lines[k]);
      const span = to - from;
      if (span < minSpan) continue;
      if (edges.length >= MAX_EDGES) {
        overflow += 1;
        continue;
      }
      edges.push({
        id: `${device.id}:${k}`,
        group: device.group || device.id,
        deviceId: device.id,
        kind: device.kind,
        label: device.label,
        family,
        rgb,
        confidence: device.confidence,
        from,
        to,
        span,
      });
      nodes[from].degree += 1;
      nodes[to].degree += 1;
    }
  }

  // The bow of an arc is the square root of its reach — linear collapses
  // every local rhyme in a long lyric onto the spine and leaves only the
  // callbacks visible.
  const bowFraction = (span: number): number =>
    n > 1 ? clamp01(Math.sqrt(span / n)) : 0;
  const widest = edges.reduce((max, e) => Math.max(max, bowFraction(e.span)), 0);
  const field = Math.max(MIN_FIELD, 26 + widest * MAX_BOW);
  const spineX = BOW_LIMIT + field;

  const sections: WebModel['sections'] = [];
  nodes.forEach((node, i) => {
    const last = sections[sections.length - 1];
    if (last && last.name === node.section) last.to = i;
    else sections.push({ name: node.section, from: i, to: i });
  });

  // Tall enough that a 200-line lyric still has a readable spine, and never so
  // short that a twelve-line one is a postage stamp in the middle of the pane:
  // the arcs are the picture, and they need room between the nodes to be told
  // apart at all.
  const height = PAD_TOP + PAD_BOTTOM + Math.max(420, n * (n > TIGHT_ROWS ? 9 : 26));
  return { nodes, edges, indexOf, sections, spineX, height, overflow };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Centre and radius of the RING layout. One definition, so the rim, the
 *  labels and the chords cannot disagree about where the circle is. */
const ringGeometry = (height: number): { cx: number; cy: number; r: number } => {
  const cy = PAD_TOP + (height - PAD_TOP - PAD_BOTTOM) / 2;
  return {
    cx: W / 2,
    cy,
    r: Math.max(80, Math.min(W * 0.34, (height - PAD_TOP - PAD_BOTTOM) * 0.42)),
  };
};

/** Where a node sits on the canvas, in the layout asked for. */
const place = (
  node: WebNode,
  layout: WebLayout,
  model: WebModel,
): { x: number; y: number; angle: number } => {
  const height = model.height;
  if (layout === 'ring') {
    const { cx, cy, r } = ringGeometry(height);
    // Start at the top and run clockwise, so reading order is clock order, and
    // stop just short of a full turn so the last line does not land on the
    // first one.
    const angle = -Math.PI / 2 + node.t * Math.PI * 2 * 0.985;
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, angle };
  }
  const top = PAD_TOP;
  const bottom = height - PAD_BOTTOM;
  return { x: model.spineX, y: top + node.t * (bottom - top), angle: 0 };
};

/** The arc for one edge: bowed left into the empty half in ARC, a chord in RING. */
const edgePath = (
  edge: WebEdge,
  model: WebModel,
  layout: WebLayout,
): { d: string; ax: number; ay: number; bx: number; by: number } => {
  const a = place(model.nodes[edge.from], layout, model);
  const b = place(model.nodes[edge.to], layout, model);
  if (layout === 'ring') {
    // A chord pulled toward the centre by how far apart the two lines are:
    // neighbours stay near the rim, a callback across the song cuts across.
    const { cx, cy } = ringGeometry(model.height);
    const reach = model.nodes.length > 1 ? edge.span / model.nodes.length : 0;
    const pull = 0.15 + clamp01(reach) * 0.85;
    const mx = a.x + (cx - a.x) * pull;
    const my = a.y + (cy - a.y) * pull;
    const nx = b.x + (cx - b.x) * pull;
    const ny = b.y + (cy - b.y) * pull;
    return { d: `M ${a.x} ${a.y} C ${mx} ${my}, ${nx} ${ny}, ${b.x} ${b.y}`, ax: a.x, ay: a.y, bx: b.x, by: b.y };
  }
  // The bow is the reach: two neighbouring lines make a small bulge, a
  // callback across the whole song makes the widest arc on the page. Square
  // root rather than linear, or every local rhyme in a long lyric collapses
  // onto the spine and only the callbacks are visible at all.
  const reach = model.nodes.length > 1 ? edge.span / model.nodes.length : 0;
  const bow = Math.min(model.spineX - BOW_LIMIT, 26 + clamp01(Math.sqrt(reach)) * MAX_BOW);
  const mid = (a.y + b.y) / 2;
  return {
    d: `M ${a.x} ${a.y} C ${a.x - bow} ${a.y + (mid - a.y) * 0.35}, ${b.x - bow} ${b.y - (b.y - mid) * 0.35}, ${b.x} ${b.y}`,
    ax: a.x,
    ay: a.y,
    bx: b.x,
    by: b.y,
  };
};

const fileStem = (title: string): string =>
  (title || 'lyric').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lyric';

/** Hand the browser a file. Same shape as the SING tab's LRC export: a real
 *  anchor with a real object URL, revoked once the click has been taken. */
const saveBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Chrome needs the URL to outlive the click by a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export interface RhymeWebProps {
  title: string;
  model: SheetModel;
  devices: readonly Device[];
  onClose: () => void;
  onPickDevice: (deviceId: string) => void;
  selectedGroup: string | null;
}

/**
 * The web, over the whole pane, with its own controls and its own export.
 *
 * Held as a dialog rather than as another section of the pane because it
 * wants the width: at split-pane size the arcs of a 60-line lyric are three
 * pixels apart and the picture says nothing.
 */
export const RhymeWeb: React.FC<RhymeWebProps> = ({
  title,
  model,
  devices,
  onClose,
  onPickDevice,
  selectedGroup,
}) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [layout, setLayout] = useState<WebLayout>('arc');
  const [families, setFamilies] = useState<ReadonlySet<DeviceFamily>>(
    () => new Set<DeviceFamily>(['rhyme']),
  );
  const [minSpan, setMinSpan] = useState(1);
  const [labels, setLabels] = useState(true);
  const [hover, setHover] = useState<string | null>(null);

  const web = useMemo(
    () => buildWebModel(model.rows, devices, families, minSpan),
    [model.rows, devices, families, minSpan],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleFamily = useCallback((family: DeviceFamily) => {
    setFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }, []);

  /** The SVG exactly as drawn, as a standalone file.
   *
   *  Serialised from the live node rather than re-rendered, so what lands in
   *  the file is what is on the screen; the only thing added is the xmlns and
   *  a solid background, because an SVG opened on its own has neither. */
  const svgText = useCallback((): string => {
    const node = svgRef.current;
    if (!node) return '';
    const clone = node.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(W));
    clone.setAttribute('height', String(web.height));
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', String(W));
    bg.setAttribute('height', String(web.height));
    bg.setAttribute('fill', '#07050a');
    clone.insertBefore(bg, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }, [web.height]);

  const exportSvg = useCallback(() => {
    const text = svgText();
    if (!text) return;
    saveBlob(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }), `${fileStem(title)}-rhyme-web.svg`);
  }, [svgText, title]);

  /** The same picture as a PNG, at 2x, for anywhere an SVG will not go. */
  const exportPng = useCallback(() => {
    const text = svgText();
    if (!text) return;
    const scale = 2;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = W * scale;
      canvas.height = web.height * scale;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#07050a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) saveBlob(blob, `${fileStem(title)}-rhyme-web.png`);
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [svgText, title, web.height]);

  // Wide arcs first so the local chatter is drawn over them rather than
  // hidden under them, and the selected group last of all.
  const drawn = useMemo(() => {
    const rest = web.edges.filter((e) => e.group !== selectedGroup);
    const lit = web.edges.filter((e) => e.group === selectedGroup);
    rest.sort((a, b) => b.span - a.span);
    return [...rest, ...lit];
  }, [web.edges, selectedGroup]);

  const paths = useMemo(
    () => drawn.map((edge) => ({ edge, ...edgePath(edge, web, layout) })),
    [drawn, web, layout],
  );

  const maxDegree = useMemo(
    () => web.nodes.reduce((max, node) => Math.max(max, node.degree), 0),
    [web.nodes],
  );

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-[#07050a]"
      role="dialog"
      aria-modal="true"
      aria-label={`The rhyme web of ${title}`}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/10 bg-white/4 px-2 py-1.5 font-mono text-[10px]">
        <span className="truncate text-zinc-100" title={title}>
          {title}
        </span>
        <span className="text-zinc-500">the whole web</span>

        <span className="flex items-center gap-0.5" role="group" aria-label="Layout">
          {(
            [
              ['arc', 'ARC', 'Lines down a spine in reading order; a connection bows out by how far it reaches'],
              ['ring', 'RING', 'The same lines closed into a circle, connections as chords: density rather than distance'],
            ] as Array<[WebLayout, string, string]>
          ).map(([key, text, hint]) => (
            <button
              key={key}
              type="button"
              className={`rounded px-1.5 py-0.5 transition-colors ${
                layout === key
                  ? 'bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/50'
                  : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
              }`}
              onClick={() => setLayout(key)}
              aria-pressed={layout === key}
              title={hint}
            >
              {text}
            </button>
          ))}
        </span>

        <span className="flex items-center gap-2">
          {WEB_FAMILIES.map((family) => (
            <span key={family} className="flex items-center gap-1">
              <input
                id={`web-family-${family}`}
                name={`web-family-${family}`}
                type="checkbox"
                className="accent-rose-400"
                checked={families.has(family)}
                onChange={() => toggleFamily(family)}
              />
              <label
                htmlFor={`web-family-${family}`}
                className={`cursor-pointer select-none ${families.has(family) ? 'text-zinc-100' : 'text-zinc-500'}`}
                style={families.has(family) ? { color: `rgb(${FAMILY_RGB[family]})` } : undefined}
              >
                {FAMILY_WORDS[family]}
              </label>
            </span>
          ))}
        </span>

        <span className="flex items-center gap-1">
          <label htmlFor="web-min-span" className="text-zinc-400">
            REACH
          </label>
          <input
            id="web-min-span"
            name="web-min-span"
            type="range"
            min={1}
            max={16}
            step={1}
            value={minSpan}
            onChange={(e) => setMinSpan(Number(e.target.value))}
            className="w-24 accent-rose-400"
            title="Hide the short connections. At 1 everything is drawn; wind it up and only the rhymes that travel are left."
          />
          <span className="w-10 tabular-nums text-zinc-200">{minSpan} ln</span>
        </span>

        <span className="flex items-center gap-1">
          <input
            id="web-labels"
            name="web-labels"
            type="checkbox"
            className="accent-rose-400"
            checked={labels}
            onChange={(e) => setLabels(e.target.checked)}
          />
          <label htmlFor="web-labels" className="cursor-pointer select-none text-zinc-300">
            WORDS
          </label>
        </span>

        <span className="ml-auto flex items-center gap-2">
          <span className="tabular-nums text-zinc-500">
            {web.nodes.length} lines · {web.edges.length} connections
            {web.overflow > 0 && ` · ${web.overflow} not drawn`}
          </span>
          <button
            type="button"
            className="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-zinc-200"
            onClick={exportSvg}
            title="Download the chart as SVG — the same picture as on screen, at any size"
          >
            <Download className="h-3 w-3" /> SVG
          </button>
          <button
            type="button"
            className="btn-ghost flex items-center gap-1 px-1.5 py-0.5 text-zinc-200"
            onClick={exportPng}
            title="Download the chart as a 2x PNG"
          >
            <Download className="h-3 w-3" /> PNG
          </button>
          <button
            type="button"
            className="btn-ghost px-1.5 py-0.5 text-zinc-300"
            onClick={onClose}
            aria-label="Close the web"
            title="Close (Esc)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {web.nodes.length < 2 ? (
          <div className="flex h-full items-center justify-center font-mono text-[10px] text-zinc-500">
            Not enough lines to draw a web.
          </div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${web.height}`}
            width="100%"
            height={web.height}
            role="img"
            aria-label={`${web.edges.length} connections between ${web.nodes.length} lines of ${title}`}
            style={{ maxWidth: '100%' }}
          >
            <text x={16} y={26} fill="rgb(228 228 231)" fontFamily="ui-monospace, monospace" fontSize={15}>
              {title}
            </text>
            <text x={16} y={44} fill="rgb(113 113 122)" fontFamily="ui-monospace, monospace" fontSize={10}>
              {`${web.nodes.length} lines · ${web.edges.length} connections · ${Array.from(families).join(', ') || 'nothing'} · reach ${minSpan}+`}
            </text>

            {paths.map(({ edge, d }) => {
              const on = !!selectedGroup && edge.group === selectedGroup;
              const lit = hover === edge.group;
              return (
                <path
                  key={edge.id}
                  d={d}
                  fill="none"
                  stroke={`rgb(${edge.rgb})`}
                  strokeWidth={on || lit ? 2.4 : 0.6 + edge.confidence * 1.1}
                  strokeOpacity={
                    on || lit ? 0.95 : selectedGroup ? 0.08 : 0.16 + edge.confidence * 0.3
                  }
                  strokeLinecap="round"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(edge.group)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onPickDevice(edge.deviceId)}
                >
                  <title>{`${edge.kind.replace(/-/g, ' ')} · lines ${web.nodes[edge.from].line + 1} → ${
                    web.nodes[edge.to].line + 1
                  } · ${edge.label}`}</title>
                </path>
              );
            })}

            {/* The ring's own rim, so the circle is visible even where no line
                on it is connected to anything. */}
            {layout === 'ring' &&
              (() => {
                const { cx, cy, r } = ringGeometry(web.height);
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke="rgb(255 255 255)"
                    strokeOpacity={0.07}
                    strokeWidth={1}
                  />
                );
              })()}

            {/* The sections, as bands at the left edge: where you are in the
                song. Drawn after the wiring so a name is never lost under an
                arc that happens to pass through it. */}
            {layout === 'arc' &&
              web.sections.map((section, i) => {
                const a = place(web.nodes[section.from], layout, web);
                const b = place(web.nodes[section.to], layout, web);
                return (
                  <g key={`${section.name}-${i}`}>
                    <line
                      x1={22}
                      y1={a.y - 4}
                      x2={22}
                      y2={b.y + 4}
                      stroke="rgb(251 113 133)"
                      strokeOpacity={0.4}
                      strokeWidth={2}
                    />
                    {section.name && (
                      <text
                        x={30}
                        y={a.y + 4}
                        fill="rgb(251 113 133)"
                        fillOpacity={0.85}
                        fontFamily="ui-monospace, monospace"
                        fontSize={9}
                        dominantBaseline="middle"
                      >
                        {section.name}
                      </text>
                    )}
                  </g>
                );
              })}

            {web.nodes.map((node) => {
              const at = place(node, layout, web);
              const ink = node.classIndex >= 0 ? inkAt(node.classIndex) : null;
              const weight = maxDegree ? node.degree / maxDegree : 0;
              return (
                <g key={node.line}>
                  <circle
                    cx={at.x}
                    cy={at.y}
                    r={2.6 + weight * 3.6}
                    fill={ink ? `rgb(${ink.rgb})` : 'rgb(113 113 122)'}
                    fillOpacity={node.degree ? 0.95 : 0.4}
                  >
                    <title>{`line ${node.line + 1}${node.letter ? ` · class ${node.letter}` : ''} · ${
                      node.degree
                    } connections — ${node.text}`}</title>
                  </circle>
                  {layout === 'ring' && labels && (
                    <text
                      x={at.x + Math.cos(at.angle) * 12}
                      y={at.y + Math.sin(at.angle) * 12}
                      fill={ink ? `rgb(${ink.rgb})` : 'rgb(113 113 122)'}
                      fillOpacity={node.degree ? 0.95 : 0.5}
                      fontFamily="ui-monospace, monospace"
                      fontSize={9}
                      textAnchor={Math.cos(at.angle) < -0.2 ? 'end' : Math.cos(at.angle) > 0.2 ? 'start' : 'middle'}
                      dominantBaseline="middle"
                    >
                      {`${node.line + 1}${node.letter ? ` ${node.letter}` : ''}`}
                      <title>{node.text}</title>
                    </text>
                  )}
                  {layout === 'arc' && (
                    <text
                      x={at.x + 10}
                      y={at.y}
                      fill={ink ? `rgb(${ink.rgb})` : 'rgb(113 113 122)'}
                      fillOpacity={0.9}
                      fontFamily="ui-monospace, monospace"
                      fontSize={9}
                      dominantBaseline="middle"
                    >
                      {node.letter || '·'}
                    </text>
                  )}
                  {labels && layout === 'arc' && (
                    <text
                      x={at.x + 26}
                      y={at.y}
                      fill="rgb(212 212 216)"
                      fontFamily="ui-monospace, monospace"
                      fontSize={9}
                      dominantBaseline="middle"
                    >
                      {node.text.length > 52 ? `${node.text.slice(0, 51)}…` : node.text}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
};

export default RhymeWeb;
