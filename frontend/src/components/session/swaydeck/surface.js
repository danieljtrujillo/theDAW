// Ported VERBATIM from SwayCommand (src/renderer/ui/surface.js) so PERFORM's
// assignment deck is the EXACT visual the standalone cockpit draws — same
// schematic, same control-id grammar (pad:N, knob:N, button:N, xy:x, xy:y,
// gesture:*), same reticle. Keep byte-parity with upstream where possible;
// improvements belong in SwayCommand first, then re-port.
//
// The Sway deck — a stroke line-art schematic of the hardware, drawn once as
// SVG and mutated per frame. It is the assignment surface: every interactive
// node carries data-ctl in the shared control-id grammar (pad:N, knob:N,
// button:N, xy:x, xy:y, gesture:*), so clicking on screen and touching the
// hardware select the same thing.
//
// Geometry is a stylized 1266×160 schematic: each cluster keeps the
// hardware's internal proportions, only the spacing between clusters
// stretches. Mirror-symmetric about x=633: rear LED beam, IR sensor field,
// per side 4 click knobs over a 4×2 pad block with 2×2 slim buttons inboard,
// center preset row, display, and scroll wheel (display-only).

const NS = 'http://www.w3.org/2000/svg';

// Screen cell → pad index, as the user numbered the deck (2026-08-20
// screenshot): top rows first, left to right — left cluster 0-3, right
// cluster 4-7 — then the bottom rows, left cluster 8-11, right cluster 12-15.
// Pads are displayed 0-based everywhere (PAD 0 … PAD 15). Nothing else
// references the geometry; a hardware monitor session (scripts/
// midi-session.ps1) confirms or corrects this table alone.
export const PAD_CELLS = [
  { x: 32, y: 92 }, { x: 104, y: 92 }, { x: 176, y: 92 }, { x: 248, y: 92 },
  { x: 954, y: 92 }, { x: 1026, y: 92 }, { x: 1098, y: 92 }, { x: 1170, y: 92 },
  { x: 32, y: 125 }, { x: 104, y: 125 }, { x: 176, y: 125 }, { x: 248, y: 125 },
  { x: 954, y: 125 }, { x: 1026, y: 125 }, { x: 1098, y: 125 }, { x: 1170, y: 125 },
];
const PAD_W = 64;
const PAD_H = 27;

const KNOB_X = [56, 132, 208, 284, 982, 1058, 1134, 1210];
const KNOB_Y = 72;
const KNOB_R = 13;

const BTN_CELLS = [
  { x: 330, y: 92 }, { x: 362, y: 92 }, { x: 330, y: 125 }, { x: 362, y: 125 },
  { x: 878, y: 92 }, { x: 910, y: 92 }, { x: 878, y: 125 }, { x: 910, y: 125 },
];
const BTN_W = 26;
const BTN_H = 27;

const CHIPS = [
  { ctl: 'xy:x', label: 'X' },
  { ctl: 'xy:y', label: 'Y' },
  { ctl: 'gesture:pulse', label: 'PULSE' },
  { ctl: 'gesture:press', label: 'PRESS' },
  { ctl: 'gesture:sway', label: 'SWAY' },
];
const CHIP_W = 60;
const CHIP_H = 18;
const CHIP_Y = 58;
const CHIP_X0 = 633 - (CHIPS.length * CHIP_W + (CHIPS.length - 1) * 8) / 2;

const BEAM_X0 = 24;
const BEAM_X1 = 1242;
const SEG_GAP = 2;
const SEG_W = (BEAM_X1 - BEAM_X0 - 15 * SEG_GAP) / 16;

export function createSurface(container, { onSelect }) {
  const parts = [];
  parts.push('<svg id="sway-svg" viewBox="0 0 1266 160" preserveAspectRatio="xMidYMid meet">');

  // LED beam
  for (let i = 0; i < 16; i++) {
    const x = BEAM_X0 + i * (SEG_W + SEG_GAP);
    parts.push(`<rect id="led-${i}" x="${x.toFixed(1)}" y="8" width="${SEG_W.toFixed(1)}" height="10" fill="#123" opacity="0.2" />`);
  }

  // IR sensor field
  parts.push('<rect id="sensor-field" class="etch" x="24" y="24" width="1218" height="26" />');
  for (let i = 0; i < 16; i++) {
    const x = BEAM_X0 + i * (SEG_W + SEG_GAP) + SEG_W / 2;
    parts.push(`<line class="etch" x1="${x.toFixed(1)}" y1="44" x2="${x.toFixed(1)}" y2="48" />`);
  }
  parts.push('<circle id="xy-dot" cx="633" cy="37" r="4" fill="var(--accent)" opacity="0.9" />');

  // Gesture chips
  for (let i = 0; i < CHIPS.length; i++) {
    const x = CHIP_X0 + i * (CHIP_W + 8);
    const c = CHIPS[i];
    parts.push(
      `<g class="ctl" data-ctl="${c.ctl}" tabindex="0" role="button" aria-label="${c.ctl}">` +
        `<rect class="etch hit-ring" x="${x}" y="${CHIP_Y}" width="${CHIP_W}" height="${CHIP_H}" />` +
        `<text x="${x + CHIP_W / 2}" y="${CHIP_Y + 13}" text-anchor="middle">${c.label}</text>` +
        `<rect id="dim-${c.ctl.replace(':', '-')}" x="${x + 3}" y="${CHIP_Y + CHIP_H + 3}" width="0" height="2" fill="var(--accent)" />` +
        `<rect x="${x}" y="${CHIP_Y - 2}" width="${CHIP_W}" height="${CHIP_H + 10}" fill="transparent" />` +
      '</g>'
    );
  }

  // Knobs
  const arcC = 2 * Math.PI * KNOB_R;
  for (let i = 0; i < 8; i++) {
    const cx = KNOB_X[i];
    parts.push(
      `<g class="ctl" data-ctl="knob:${i}" tabindex="0" role="button" aria-label="knob:${i}">` +
        `<circle class="etch hit-ring" cx="${cx}" cy="${KNOB_Y}" r="${KNOB_R}" />` +
        `<circle id="knob-arc-${i}" cx="${cx}" cy="${KNOB_Y}" r="${KNOB_R}" fill="none" stroke="var(--accent)" stroke-width="2" ` +
          `stroke-dasharray="0 ${arcC.toFixed(1)}" transform="rotate(135 ${cx} ${KNOB_Y})" opacity="0.85" />` +
        `<line id="knob-tick-${i}" x1="${cx}" y1="${KNOB_Y - KNOB_R + 3}" x2="${cx}" y2="${KNOB_Y - 4}" stroke="var(--text-dim)" />` +
        `<circle cx="${cx}" cy="${KNOB_Y}" r="${KNOB_R + 5}" fill="transparent" />` +
      '</g>'
    );
  }

  // Pads
  for (let i = 0; i < 16; i++) {
    const c = PAD_CELLS[i];
    parts.push(
      `<g class="ctl" data-ctl="pad:${i}" tabindex="0" role="button" aria-label="pad:${i}">` +
        `<rect class="etch hit-ring" x="${c.x}" y="${c.y}" width="${PAD_W}" height="${PAD_H}" rx="3" />` +
        `<rect id="pad-fill-${i}" x="${c.x + 1}" y="${c.y + 1}" width="${PAD_W - 2}" height="${PAD_H - 2}" rx="2" fill="var(--accent)" opacity="0" />` +
        `<path id="pad-tick-${i}" d="M ${c.x + PAD_W - 8} ${c.y + 2} h 6 v 6" fill="none" stroke="var(--accent)" opacity="0" />` +
        `<text id="pad-label-${i}" x="${c.x + PAD_W / 2}" y="${c.y + PAD_H / 2 + 3}" text-anchor="middle"></text>` +
      '</g>'
    );
  }

  // Mappable buttons
  for (let i = 0; i < 8; i++) {
    const c = BTN_CELLS[i];
    parts.push(
      `<g class="ctl" data-ctl="button:${i}" tabindex="0" role="button" aria-label="button:${i}">` +
        `<rect class="etch hit-ring" x="${c.x}" y="${c.y}" width="${BTN_W}" height="${BTN_H}" rx="2" />` +
        `<rect id="btn-fill-${i}" x="${c.x + 2}" y="${c.y + 2}" width="${BTN_W - 4}" height="${BTN_H - 4}" fill="var(--accent)" opacity="0" />` +
      '</g>'
    );
  }

  // Center: preset row, display, wheel — device-local, display-only.
  for (let i = 0; i < 6; i++) {
    parts.push(`<rect class="etch" x="${571 + i * 22}" y="90" width="14" height="8" />`);
  }
  parts.push('<rect class="etch" x="543" y="106" width="180" height="44" rx="2" />');
  parts.push('<text id="oled-line" x="633" y="126" text-anchor="middle" fill="var(--accent)" opacity="0.85"></text>');
  parts.push('<text id="oled-sub" x="633" y="141" text-anchor="middle"></text>');
  parts.push('<circle class="etch" cx="763" cy="128" r="22" />');
  parts.push('<circle class="etch" cx="763" cy="128" r="9" />');
  parts.push('<line class="etch" x1="763" y1="106" x2="763" y2="112" />');

  // Selection reticle — corner brackets + pulsing diamond arms.
  parts.push(
    '<g id="reticle" visibility="hidden">' +
      '<path id="ret-tl" class="arm" d="" /><path id="ret-tr" class="arm" d="" />' +
      '<path id="ret-bl" class="arm" d="" /><path id="ret-br" class="arm" d="" />' +
      '<rect id="ret-n" class="arm" width="6" height="6" /><rect id="ret-s" class="arm" width="6" height="6" />' +
      '<rect id="ret-w" class="arm" width="6" height="6" /><rect id="ret-e" class="arm" width="6" height="6" />' +
    '</g>'
  );

  parts.push('</svg>');
  container.innerHTML = parts.join('');

  const svg = container.querySelector('#sway-svg');
  const $id = (id) => svg.querySelector(`#${CSS.escape(id)}`);

  svg.addEventListener('click', (e) => {
    const node = e.target.closest('[data-ctl]');
    if (node && onSelect) onSelect(node.dataset.ctl);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const node = e.target.closest('[data-ctl]');
    if (node && onSelect) {
      e.preventDefault();
      onSelect(node.dataset.ctl);
    }
  });

  const reticle = $id('reticle');
  const knobArcs = Array.from({ length: 8 }, (_, i) => $id(`knob-arc-${i}`));
  const knobTicks = Array.from({ length: 8 }, (_, i) => $id(`knob-tick-${i}`));
  const padFills = Array.from({ length: 16 }, (_, i) => $id(`pad-fill-${i}`));
  const padTicks = Array.from({ length: 16 }, (_, i) => $id(`pad-tick-${i}`));
  const padLabels = Array.from({ length: 16 }, (_, i) => $id(`pad-label-${i}`));
  const btnFills = Array.from({ length: 8 }, (_, i) => $id(`btn-fill-${i}`));
  const leds = Array.from({ length: 16 }, (_, i) => $id(`led-${i}`));
  const dims = CHIPS.map((c) => $id(`dim-${c.ctl.replace(':', '-')}`));
  const xyDot = $id('xy-dot');
  const sensorField = $id('sensor-field');
  const oledLine = $id('oled-line');
  const oledSub = $id('oled-sub');

  const last = { knobs: new Array(8).fill(-1), pads: new Array(16).fill(-1), oled: '' };

  function ledColor(palette, i, intensity) {
    // 5 palette colors spread across 16 segments, linearly interpolated.
    const f = (i / 15) * (palette.length - 1);
    const a = palette[Math.floor(f)];
    const b = palette[Math.min(palette.length - 1, Math.floor(f) + 1)];
    const t = f - Math.floor(f);
    const r = Math.round(((a.r + (b.r - a.r) * t) * intensity) * 255);
    const g = Math.round(((a.g + (b.g - a.g) * t) * intensity) * 255);
    const bl = Math.round(((a.b + (b.b - a.b) * t) * intensity) * 255);
    return `rgb(${r},${g},${bl})`;
  }

  return {
    el: svg,

    update(io, monitor) {
      const arcC = 2 * Math.PI * KNOB_R;
      const sweep = arcC * 0.75; // 270° of travel
      for (let i = 0; i < 8; i++) {
        const v = io.knobs[i];
        if (Math.abs(v - last.knobs[i]) > 0.002) {
          last.knobs[i] = v;
          knobArcs[i].setAttribute('stroke-dasharray', `${(v * sweep).toFixed(1)} ${arcC.toFixed(1)}`);
          knobTicks[i].setAttribute('transform', `rotate(${(-135 + v * 270).toFixed(1)} ${KNOB_X[i]} ${KNOB_Y})`);
        }
      }
      for (let i = 0; i < 16; i++) {
        const v = io.pads[i];
        if (Math.abs(v - last.pads[i]) > 0.005) {
          last.pads[i] = v;
          padFills[i].setAttribute('opacity', (v * 0.65).toFixed(2));
        }
      }
      const level = 0.12 + io.intensity * io.level * 0.9;
      for (let i = 0; i < 16; i++) {
        leds[i].setAttribute('fill', ledColor(io.palette, i, Math.min(1, 0.25 + io.intensity * 0.75)));
        leds[i].setAttribute('opacity', Math.min(1, level + io.beat * 0.5).toFixed(2));
      }
      xyDot.setAttribute('cx', (BEAM_X0 + io.xy.x * (BEAM_X1 - BEAM_X0)).toFixed(1));
      xyDot.setAttribute('cy', (48 - io.xy.y * 22).toFixed(1));
      xyDot.setAttribute('r', (3 + io.gestures.pulse * 4).toFixed(1));
      sensorField.setAttribute('stroke-opacity', (0.4 + io.gestures.press * 0.6).toFixed(2));
      const chipVals = [io.xy.x, io.xy.y, io.gestures.pulse, io.gestures.press, io.gestures.sway];
      for (let i = 0; i < dims.length; i++) {
        dims[i].setAttribute('width', (chipVals[i] * (CHIP_W - 6)).toFixed(1));
      }
      const line = monitor && monitor.length ? monitor[0] : '';
      if (line !== last.oled) {
        last.oled = line;
        oledLine.textContent = line.slice(0, 30);
      }
    },

    // Pad labels + assignment ticks; button lit state. Called on assignment
    // or kit changes, not per frame.
    refresh(labels, buttonLit) {
      for (let i = 0; i < 16; i++) {
        const text = labels[i] || '';
        padLabels[i].textContent = text.length > 9 ? `${text.slice(0, 8)}…` : text;
        padTicks[i].setAttribute('opacity', text ? '0.9' : '0');
      }
      for (let i = 0; i < 8; i++) {
        btnFills[i].setAttribute('opacity', buttonLit && buttonLit[i] ? '0.5' : '0');
      }
    },

    setStatus(text) {
      oledSub.textContent = (text || '').slice(0, 34);
    },

    select(target) {
      if (!target) {
        reticle.setAttribute('visibility', 'hidden');
        return;
      }
      const node = svg.querySelector(`[data-ctl="${CSS.escape(target)}"]`);
      if (!node) {
        reticle.setAttribute('visibility', 'hidden');
        return;
      }
      const b = node.getBBox();
      const pad = 5;
      const x0 = b.x - pad;
      const y0 = b.y - pad;
      const x1 = b.x + b.width + pad;
      const y1 = b.y + b.height + pad;
      const arm = Math.min(10, Math.max(6, b.width / 5));
      svg.querySelector('#ret-tl').setAttribute('d', `M ${x0} ${y0 + arm} V ${y0} H ${x0 + arm}`);
      svg.querySelector('#ret-tr').setAttribute('d', `M ${x1 - arm} ${y0} H ${x1} V ${y0 + arm}`);
      svg.querySelector('#ret-bl').setAttribute('d', `M ${x0} ${y1 - arm} V ${y1} H ${x0 + arm}`);
      svg.querySelector('#ret-br').setAttribute('d', `M ${x1 - arm} ${y1} H ${x1} V ${y1 - arm}`);
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const place = (id, x, y) => {
        const el = svg.querySelector(id);
        el.setAttribute('x', x - 3);
        el.setAttribute('y', y - 3);
        el.setAttribute('transform', `rotate(45 ${x} ${y})`);
      };
      place('#ret-n', cx, y0 - 6);
      place('#ret-s', cx, y1 + 6);
      place('#ret-w', x0 - 6, cy);
      place('#ret-e', x1 + 6, cy);
      reticle.setAttribute('visibility', 'visible');
    },

    setArmed(armed) {
      reticle.classList.toggle('armed', !!armed);
    },
  };
}
