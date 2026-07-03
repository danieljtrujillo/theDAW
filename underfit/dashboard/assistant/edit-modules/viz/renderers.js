/**
 * 14 archetype-specific visualization renderers for the Edit Tool Stack.
 *
 * Each export is a draw function:  (ctx, W, H, data, params) => void
 *   ctx    - CanvasRenderingContext2D (already scaled for DPR)
 *   W, H   - logical pixel dimensions
 *   data   - { freq: Float32Array, freqR: Float32Array, time: Float32Array, timeR: Float32Array, sr: number }
 *   params - the tool's current param values {}
 *
 * Pure rendering — no state, no DOM, no framework. Call at 60fps.
 */

const C = {
  accent: '#8b5cf6', accentDim: 'rgba(139,92,246,.3)', accentFill: 'rgba(139,92,246,.12)',
  grid: 'rgba(255,255,255,.04)', gridText: 'rgba(255,255,255,.13)', text: '#f5f3ff', muted: '#4b4453',
  green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444',
  font: '"IBM Plex Mono",monospace',
};
const logX = (f, w, pad) => pad + (w - pad * 2) * Math.log10(Math.max(20, f) / 20) / Math.log10(20000 / 20);
const dbY = (db, h, pad, range = 90) => pad + (h - pad * 2) * (1 - (Math.max(-range, db) + range) / range);
const meterColor = pct => pct > .92 ? C.red : pct > .75 ? C.orange : pct > .5 ? C.yellow : C.green;

// ═══════════════════════════════════════════════════════════════════════
// 1. EQ — draggable curve + nodes over live FFT
// ═══════════════════════════════════════════════════════════════════════
function drawEq(ctx, W, H, data, params) {
  const pl = 36, pr = 12, pt = 14, pb = 22, pw = W - pl - pr, ph = H - pt - pb;
  // grid
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  for (const db of [-80, -60, -40, -20, 0]) {
    const y = dbY(db, H, pt); ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pl + pw, y); ctx.stroke();
    ctx.fillStyle = C.gridText; ctx.font = `7px ${C.font}`; ctx.textAlign = 'right'; ctx.fillText(db + '', pl - 3, y + 3);
  }
  for (const f of [50, 100, 200, 500, 1e3, 2e3, 5e3, 10e3, 20e3]) {
    const x = logX(f, W, pl); ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pt + ph); ctx.stroke();
    ctx.fillStyle = C.gridText; ctx.textAlign = 'center'; ctx.font = `6px ${C.font}`;
    ctx.fillText(f >= 1e3 ? (f / 1e3) + 'k' : f + '', x, H - pb + 10);
  }
  if (!data.freq) return;
  // FFT fill
  const binHz = data.sr / (data.freq.length * 2);
  const grad = ctx.createLinearGradient(0, pt, 0, pt + ph);
  grad.addColorStop(0, 'rgba(139,92,246,.35)'); grad.addColorStop(1, 'rgba(139,92,246,.02)');
  ctx.beginPath(); ctx.moveTo(pl, pt + ph);
  for (let i = 1; i < data.freq.length; i++) {
    const f = i * binHz; if (f < 20 || f > 20000) continue;
    ctx.lineTo(logX(f, W, pl), dbY(data.freq[i], H, pt));
  }
  ctx.lineTo(pl + pw, pt + ph); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  // FFT line
  ctx.beginPath();
  for (let i = 1; i < data.freq.length; i++) {
    const f = i * binHz; if (f < 20 || f > 20000) continue;
    const x = logX(f, W, pl), y = dbY(data.freq[i], H, pt);
    i <= 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(139,92,246,.7)'; ctx.lineWidth = 1.5; ctx.stroke();
  // EQ band nodes
  const bands = [];
  if (params.lowFreq != null) bands.push({ f: params.lowFreq, g: params.lowGain || 0, c: '#f59e0b', l: 'L' });
  if (params.midFreq != null) bands.push({ f: params.midFreq, g: params.midGain || 0, c: '#8b5cf6', l: 'M' });
  if (params.highFreq != null) bands.push({ f: params.highFreq, g: params.highGain || 0, c: '#22d3ee', l: 'H' });
  if (params.band1Freq != null) bands.push({ f: params.band1Freq, g: 0, c: '#fb7185', l: '1' });
  if (params.band2Freq != null) bands.push({ f: params.band2Freq, g: 0, c: '#2dd4bf', l: '2' });
  if (params.band3Freq != null) bands.push({ f: params.band3Freq, g: 0, c: '#f59e0b', l: '3' });
  const eqDbRange = 18;
  bands.forEach(b => {
    const x = logX(b.f, W, pl), y = pt + ph / 2 - (b.g / eqDbRange) * (ph / 2);
    // glow ring
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = b.c; ctx.globalAlpha = .25; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    // solid dot
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = b.c; ctx.fill();
    // label
    ctx.fillStyle = '#000'; ctx.font = `bold 7px ${C.font}`; ctx.textAlign = 'center'; ctx.fillText(b.l, x, y + 2.5);
    // readout
    ctx.fillStyle = b.c; ctx.font = `7px ${C.font}`; ctx.fillText(Math.round(b.f) + 'Hz', x, y - 14);
    if (b.g !== 0) ctx.fillText((b.g > 0 ? '+' : '') + b.g.toFixed(1) + 'dB', x, y + 20);
  });
  // EQ curve (simplified bell response)
  if (bands.length) {
    ctx.beginPath();
    for (let px = pl; px <= pl + pw; px++) {
      const logF = Math.pow(10, (px - pl) / pw * Math.log10(20000 / 20) + Math.log10(20));
      let totalGain = 0;
      bands.forEach(b => {
        const q = params.midQ || 1.5;
        const octDist = Math.log2(logF / b.f);
        totalGain += b.g * Math.exp(-octDist * octDist * q * q * 2);
      });
      const y = pt + ph / 2 - (totalGain / eqDbRange) * (ph / 2);
      px === pl ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.stroke();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. DYNAMICS — transfer curve + GR bars
// ═══════════════════════════════════════════════════════════════════════
function drawDynamics(ctx, W, H, data, params) {
  const curveW = Math.min(H - 20, W * 0.45), pad = 16;
  const cx = pad, cy = pad, cw = curveW - pad, ch = curveW - pad;
  // transfer curve bg
  ctx.fillStyle = 'rgba(255,255,255,.02)'; ctx.fillRect(cx, cy, cw, ch);
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.strokeRect(cx, cy, cw, ch);
  // unity line
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, cy + ch); ctx.lineTo(cx + cw, cy); ctx.stroke(); ctx.setLineDash([]);
  // threshold line
  const thresh = params.lowThresh ?? params.ceiling ?? params.targetLUFS ?? -20;
  const ratio = params.lowRatio ?? 4;
  const threshNorm = Math.max(0, Math.min(1, (thresh + 60) / 60));
  const tx = cx + cw * threshNorm, ty = cy + ch * (1 - threshNorm);
  ctx.strokeStyle = 'rgba(139,92,246,.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(tx, cy); ctx.lineTo(tx, cy + ch); ctx.stroke(); ctx.setLineDash([]);
  // compression curve
  ctx.beginPath(); ctx.moveTo(cx, cy + ch);
  for (let i = 0; i <= 60; i++) {
    const inDb = -60 + i;
    let outDb = inDb;
    if (inDb > thresh) outDb = thresh + (inDb - thresh) / ratio;
    const x = cx + cw * ((inDb + 60) / 60), y = cy + ch * (1 - (outDb + 60) / 60);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.accent; ctx.lineWidth = 2.5; ctx.stroke();
  // operating point
  if (data.freq) {
    let rms = 0; for (let i = 0; i < 256; i++) rms += Math.max(0, data.freq[i] + 90); rms = rms / 256 / 90;
    const inDb = -60 + rms * 60;
    let outDb = inDb; if (inDb > thresh) outDb = thresh + (inDb - thresh) / ratio;
    const opx = cx + cw * ((inDb + 60) / 60), opy = cy + ch * (1 - (outDb + 60) / 60);
    ctx.beginPath(); ctx.arc(opx, opy, 4, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(opx, opy, 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // axis labels
  ctx.fillStyle = C.gridText; ctx.font = `6px ${C.font}`;
  ctx.textAlign = 'center'; ctx.fillText('INPUT (dB)', cx + cw / 2, cy + ch + 14);
  ctx.save(); ctx.translate(cx - 8, cy + ch / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('OUTPUT', 0, 0); ctx.restore();
  // GR bars (right side)
  const barX = cx + cw + 24, barW = 16, barH = ch, barGap = 22;
  const bandColors = ['#f59e0b', '#8b5cf6', '#22d3ee'];
  const numBands = params.lowThresh != null && params.highThresh != null ? 3 : 1;
  for (let b = 0; b < numBands; b++) {
    const bx = barX + b * barGap;
    ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(bx, cy, barW, barH);
    ctx.strokeStyle = C.grid; ctx.strokeRect(bx, cy, barW, barH);
    // simulated GR based on audio energy
    let gr = 0;
    if (data.freq) {
      let bandE = 0, cnt = 0;
      const lo = b === 0 ? 0 : b === 1 ? 80 : 200, hi = b === 0 ? 80 : b === 1 ? 200 : 512;
      for (let i = lo; i < Math.min(hi, data.freq.length); i++) { bandE += Math.max(0, data.freq[i] + 90); cnt++; }
      gr = cnt > 0 ? Math.min(1, (bandE / cnt / 90) * 0.6) : 0;
    }
    const grH = gr * barH;
    ctx.fillStyle = bandColors[b % 3]; ctx.globalAlpha = .7;
    ctx.fillRect(bx, cy, barW, grH); ctx.globalAlpha = 1;
    ctx.fillStyle = C.gridText; ctx.font = `7px ${C.font}`; ctx.textAlign = 'center';
    ctx.fillText(['LOW', 'MID', 'HI'][b] || 'GR', bx + barW / 2, cy + barH + 12);
    ctx.fillText((-gr * 20).toFixed(1), bx + barW / 2, cy - 4);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. IMAGER — goniometer + correlation
// ═══════════════════════════════════════════════════════════════════════
function drawImager(ctx, W, H, data, params) {
  const cx = W * 0.42, cy = H * 0.48, rad = Math.min(W * 0.35, H * 0.42);
  // half-circle frame
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  // cross lines
  for (const a of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
    ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * rad, cy - Math.sin(a) * rad);
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); ctx.stroke();
  }
  // L/R/M/S labels
  ctx.fillStyle = C.gridText; ctx.font = `bold 8px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText('L', cx - rad - 8, cy + 3); ctx.fillText('R', cx + rad + 8, cy + 3);
  ctx.fillText('M', cx, cy - rad - 5); ctx.fillText('S', cx, cy + rad + 12);
  // Lissajous dots
  if (data.time && data.timeR) {
    ctx.globalAlpha = .5;
    const n = Math.min(data.time.length, 512);
    for (let i = 0; i < n; i += 2) {
      const l = data.time[i], r = data.timeR[i];
      const m = (l + r) * 0.707, s = (l - r) * 0.707;
      const px = cx + s * rad * 0.9, py = cy - m * rad * 0.9;
      ctx.fillStyle = `hsla(${260 + Math.abs(s) * 100}, 70%, 65%, ${0.3 + Math.abs(m) * 0.5})`;
      ctx.fillRect(px - 1, py - 1, 2, 2);
    }
    ctx.globalAlpha = 1;
  }
  // Correlation meter bar (bottom right)
  const barX = W * 0.75, barY = H * 0.2, barW = W * 0.18, barH = 8;
  ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fillRect(barX, barY, barW, barH);
  let corr = 0;
  if (data.time && data.timeR) {
    let sumLR = 0, sumL2 = 0, sumR2 = 0;
    for (let i = 0; i < Math.min(data.time.length, 512); i++) {
      sumLR += data.time[i] * data.timeR[i]; sumL2 += data.time[i] ** 2; sumR2 += data.timeR[i] ** 2;
    }
    corr = sumLR / (Math.sqrt(sumL2 * sumR2) + 1e-9);
  }
  const corrX = barX + barW * (corr + 1) / 2;
  ctx.fillStyle = corr > 0 ? C.green : corr > -0.3 ? C.yellow : C.red;
  ctx.fillRect(corrX - 2, barY - 2, 4, barH + 4);
  // center mark
  ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.beginPath();
  ctx.moveTo(barX + barW / 2, barY - 1); ctx.lineTo(barX + barW / 2, barY + barH + 1); ctx.stroke();
  ctx.fillStyle = C.gridText; ctx.font = `6px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText('-1', barX, barY - 4); ctx.fillText('0', barX + barW / 2, barY - 4); ctx.fillText('+1', barX + barW, barY - 4);
  ctx.fillStyle = C.muted; ctx.font = `7px ${C.font}`; ctx.fillText('CORRELATION', barX + barW / 2, barY + barH + 14);
  // Width readout
  const width = params.width ?? 100;
  ctx.fillStyle = C.accent; ctx.font = `bold 18px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText(width + '%', W * 0.82, H * 0.65);
  ctx.fillStyle = C.muted; ctx.font = `7px ${C.font}`; ctx.fillText('WIDTH', W * 0.82, H * 0.65 + 14);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. METERS — big LUFS + L/R bars + history
// ═══════════════════════════════════════════════════════════════════════
const lufsHistory = [];
function drawMeters(ctx, W, H, data, params) {
  // L/R peak meters
  const barW = 14, barH = H - 40, barY = 16, barGap = 6;
  const bars = [{ d: data.time, label: 'L', x: 16 }, { d: data.timeR, label: 'R', x: 16 + barW + barGap }];
  bars.forEach(b => {
    ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(b.x, barY, barW, barH);
    let peak = 0;
    if (b.d) for (let i = 0; i < b.d.length; i++) peak = Math.max(peak, Math.abs(b.d[i]));
    const db = peak > 0 ? 20 * Math.log10(peak) : -90;
    const pct = Math.max(0, Math.min(1, (db + 60) / 60));
    const fillH = pct * barH;
    // segmented meter
    const segs = 20;
    for (let s = 0; s < segs; s++) {
      const sp = s / segs;
      if (sp > pct) break;
      const sy = barY + barH - (s + 1) * (barH / segs), sh = barH / segs - 1;
      ctx.fillStyle = sp > .92 ? C.red : sp > .75 ? C.orange : sp > .5 ? C.yellow : C.green;
      ctx.globalAlpha = .85; ctx.fillRect(b.x, sy, barW, sh); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = C.gridText; ctx.font = `7px ${C.font}`; ctx.textAlign = 'center';
    ctx.fillText(b.label, b.x + barW / 2, barY + barH + 12);
    ctx.fillText(db > -90 ? db.toFixed(1) : '−∞', b.x + barW / 2, barY - 4);
  });
  // Big LUFS number
  let lufs = -90;
  if (data.time && data.timeR) {
    let sum = 0;
    for (let i = 0; i < data.time.length; i++) sum += data.time[i] ** 2 + (data.timeR[i] || 0) ** 2;
    const rms = Math.sqrt(sum / data.time.length / 2);
    lufs = rms > 0 ? 20 * Math.log10(rms) - 0.691 : -90;
  }
  lufsHistory.push(lufs); if (lufsHistory.length > 120) lufsHistory.shift();
  const target = params.target_platform ? -14 : (params.custom_target_lufs || -14);
  ctx.fillStyle = '#fff'; ctx.font = `bold 32px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText(lufs > -80 ? lufs.toFixed(1) : '—', W * 0.5, H * 0.4);
  ctx.fillStyle = C.accent; ctx.font = `bold 9px ${C.font}`;
  ctx.fillText('LUFS INTEGRATED', W * 0.5, H * 0.4 + 16);
  // Target indicator
  ctx.fillStyle = Math.abs(lufs - target) < 1.5 ? C.green : C.yellow;
  ctx.font = `bold 10px ${C.font}`;
  ctx.fillText(`TARGET: ${target}`, W * 0.5, H * 0.4 + 32);
  // History sparkline
  const hx = 70, hy = H - 36, hw = W - 90, hh = 28;
  ctx.fillStyle = 'rgba(255,255,255,.02)'; ctx.fillRect(hx, hy, hw, hh);
  ctx.beginPath();
  lufsHistory.forEach((v, i) => {
    const x = hx + (i / 120) * hw, y = hy + hh * (1 - Math.max(0, (v + 60) / 60));
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.stroke();
  // target line on sparkline
  const tly = hy + hh * (1 - Math.max(0, (target + 60) / 60));
  ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(hx, tly); ctx.lineTo(hx + hw, tly); ctx.stroke(); ctx.setLineDash([]);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. SPECTRUM — before/after overlay
// ═══════════════════════════════════════════════════════════════════════
function drawSpectrum(ctx, W, H, data, params) {
  const pl = 36, pr = 8, pt = 14, pb = 20;
  // grid
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  for (const f of [100, 500, 1e3, 5e3, 10e3]) {
    const x = logX(f, W, pl); ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, H - pb); ctx.stroke();
    ctx.fillStyle = C.gridText; ctx.font = `6px ${C.font}`; ctx.textAlign = 'center';
    ctx.fillText(f >= 1e3 ? (f / 1e3) + 'k' : f + '', x, H - pb + 10);
  }
  if (!data.freq) return;
  const binHz = data.sr / (data.freq.length * 2), pw = W - pl - pr, ph = H - pt - pb;
  // "before" spectrum (dimmed)
  ctx.beginPath();
  for (let i = 1; i < data.freq.length; i++) {
    const f = i * binHz; if (f < 20 || f > 20000) continue;
    const x = logX(f, W, pl), y = dbY(data.freq[i], H, pt);
    i <= 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 1; ctx.stroke();
  // "after" spectrum (bright accent — simulated as boosted version)
  ctx.beginPath();
  for (let i = 1; i < data.freq.length; i++) {
    const f = i * binHz; if (f < 20 || f > 20000) continue;
    const boost = (params.amount ?? params.intensity ?? 0.5) * 6;
    const x = logX(f, W, pl), y = dbY(data.freq[i] + boost, H, pt);
    i <= 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.stroke();
  // difference fill between the two
  ctx.beginPath(); ctx.moveTo(pl, H - pb);
  for (let i = 1; i < data.freq.length; i++) {
    const f = i * binHz; if (f < 20 || f > 20000) continue;
    const boost = (params.amount ?? params.intensity ?? 0.5) * 6;
    const x = logX(f, W, pl), y = dbY(data.freq[i] + boost, H, pt);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W - pr, H - pb); ctx.closePath();
  ctx.fillStyle = 'rgba(139,92,246,.08)'; ctx.fill();
  // label
  ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.font = `7px ${C.font}`; ctx.textAlign = 'left';
  ctx.fillText('ORIGINAL', pl + 4, pt + 10);
  ctx.fillStyle = C.accent; ctx.fillText('PROCESSED', pl + 4, pt + 20);
}

// ═══════════════════════════════════════════════════════════════════════
// 6. SPECTROGRAM — scrolling heatmap
// ═══════════════════════════════════════════════════════════════════════
const spectroHist = [];
const SBINS = 96, SFRAMES = 180;
function drawSpectro(ctx, W, H, data, params) {
  if (data.freq) {
    const frame = new Float32Array(SBINS);
    const step = Math.floor(data.freq.length / SBINS);
    for (let i = 0; i < SBINS; i++) { let s = 0; for (let j = 0; j < step; j++) s += data.freq[i * step + j]; frame[i] = s / step; }
    spectroHist.push(frame); if (spectroHist.length > SFRAMES) spectroHist.shift();
  }
  const cw = W / SFRAMES, ch = H / SBINS;
  for (let t = 0; t < spectroHist.length; t++) {
    const fr = spectroHist[t];
    for (let b = 0; b < SBINS; b++) {
      const db = Math.max(-90, fr[SBINS - 1 - b]), norm = (db + 90) / 90;
      const r = Math.floor(norm * 160 + norm * norm * 95), g = Math.floor(norm * 30 + norm * norm * 160), bl = Math.floor(18 + norm * 237);
      ctx.fillStyle = `rgb(${r},${g},${bl})`; ctx.fillRect(t * cw, b * ch, cw + .5, ch + .5);
    }
  }
  // freq axis (right edge)
  ctx.fillStyle = C.gridText; ctx.font = `6px ${C.font}`; ctx.textAlign = 'right';
  const sr = data.sr || 44100;
  [100, 500, 1e3, 2e3, 5e3, 10e3, 20e3].forEach(f => {
    if (f > sr / 2) return;
    const y = H * (1 - Math.log10(f / 20) / Math.log10(sr / 2 / 20));
    ctx.fillText(f >= 1e3 ? (f / 1e3) + 'k' : f + '', W - 4, y + 3);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 7. WAVE — waveform + event markers
// ═══════════════════════════════════════════════════════════════════════
function drawWave(ctx, W, H, data, params) {
  const mid = H / 2, amp = H * 0.4;
  // center line
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
  if (!data.time) return;
  // waveform
  const step = Math.max(1, Math.floor(data.time.length / W));
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const i = Math.min(x * step, data.time.length - 1);
    const y = mid - data.time[i] * amp;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.stroke();
  // fill
  ctx.lineTo(W, mid); ctx.lineTo(0, mid); ctx.closePath();
  ctx.fillStyle = 'rgba(139,92,246,.06)'; ctx.fill();
  // simulated event markers (red vertical lines at regular intervals for clicks/clips)
  const threshold = params.threshold ?? params.clipThreshold ?? 0.8;
  for (let x = 0; x < W; x += 3) {
    const i = Math.min(x * step, data.time.length - 1);
    if (Math.abs(data.time[i]) > threshold) {
      ctx.strokeStyle = 'rgba(239,68,68,.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 8. VORTEX — Clarity-style particle spiral
// ═══════════════════════════════════════════════════════════════════════
const vortexParts = [];
for (let i = 0; i < 200; i++) vortexParts.push({ a: Math.random() * Math.PI * 2, r: 20 + Math.random() * 150, speed: .15 + Math.random() * .5, size: .6 + Math.random() * 2, hue: 260 + Math.random() * 60 });
function drawVortex(ctx, W, H, data, params) {
  const cx = W / 2, cy = H / 2, t = performance.now() / 1000;
  let energy = 0;
  if (data.freq) { for (let i = 0; i < 256; i++) energy += Math.max(0, data.freq[i] + 90); energy /= 256 * 90; }
  // particles
  ctx.globalCompositeOperation = 'screen';
  vortexParts.forEach(p => {
    p.a += p.speed * .01;
    const r2 = p.r * (.5 + energy * 1.5);
    const px = cx + Math.cos(p.a + t * .15) * r2 * 1.2, py = cy + Math.sin(p.a * 1.5 + t * .2) * r2 * .7;
    const sz = p.size * (.6 + energy * 2.5);
    ctx.beginPath(); ctx.arc(px, py, sz, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue},75%,65%,${.25 + energy * .6})`; ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
  // center glow ring
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 60 + energy * 40);
  grad.addColorStop(0, `rgba(139,92,246,${.2 + energy * .25})`); grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = `rgba(139,92,246,${.3 + energy * .3})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, 28 + energy * 15, 0, Math.PI * 2); ctx.stroke();
  // macro value
  const val = params.processAmount ?? params.enhance ?? params.strength ?? 0.8;
  ctx.fillStyle = '#fff'; ctx.font = `bold 20px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText(Math.round(val * 100) + '%', cx, cy + 6);
  ctx.fillStyle = C.muted; ctx.font = `7px ${C.font}`; ctx.fillText('PROCESS', cx, cy + 18);
}

// ═══════════════════════════════════════════════════════════════════════
// 9. PAINT — interactive spectrogram with crosshair
// ═══════════════════════════════════════════════════════════════════════
function drawPaint(ctx, W, H, data, params) {
  drawSpectro(ctx, W, H, data, params);
  // selection rectangle overlay
  const sx = W * 0.3, sy = H * 0.2, sw = W * 0.25, sh = H * 0.35;
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
  ctx.strokeRect(sx, sy, sw, sh); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(139,92,246,.12)'; ctx.fillRect(sx, sy, sw, sh);
  // crosshair
  ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sx + sw / 2, sy - 8); ctx.lineTo(sx + sw / 2, sy + sh + 8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx - 8, sy + sh / 2); ctx.lineTo(sx + sw + 8, sy + sh / 2); ctx.stroke();
  // label
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = `8px ${C.font}`; ctx.textAlign = 'left';
  ctx.fillText('PAINT / SELECT REGION', 6, H - 6);
}

// ═══════════════════════════════════════════════════════════════════════
// 10. GRAIN — particle cloud
// ═══════════════════════════════════════════════════════════════════════
const grainDots = [];
for (let i = 0; i < 300; i++) grainDots.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - .5) * .003, vy: (Math.random() - .5) * .003, size: .5 + Math.random() * 2.5, hue: 260 + Math.random() * 80 });
function drawGrain(ctx, W, H, data, params) {
  let energy = 0;
  if (data.freq) { for (let i = 0; i < 128; i++) energy += Math.max(0, data.freq[i] + 90); energy /= 128 * 90; }
  const scatter = params.scatter ?? 0.3, density = (params.density ?? 40) / 200;
  ctx.globalCompositeOperation = 'screen';
  const visibleCount = Math.floor(grainDots.length * density);
  for (let i = 0; i < visibleCount; i++) {
    const g = grainDots[i];
    g.x += g.vx * (1 + scatter * 3 + energy * 2); g.y += g.vy * (1 + scatter * 3 + energy * 2);
    if (g.x < 0 || g.x > 1) g.vx *= -1; if (g.y < 0 || g.y > 1) g.vy *= -1;
    g.x = Math.max(0, Math.min(1, g.x)); g.y = Math.max(0, Math.min(1, g.y));
    const sz = g.size * (1 + energy * 3);
    ctx.beginPath(); ctx.arc(g.x * W, g.y * H, sz, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${g.hue},70%,60%,${.2 + energy * .5 + scatter * .2})`; ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  // grain size indicator
  const gs = params.grainSize ?? 80;
  ctx.fillStyle = C.muted; ctx.font = `7px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText(`GRAIN ${gs}ms · SCATTER ${(scatter * 100).toFixed(0)}%`, W / 2, H - 8);
}

// ═══════════════════════════════════════════════════════════════════════
// 11. XY — morph pad with draggable puck
// ═══════════════════════════════════════════════════════════════════════
function drawXY(ctx, W, H, data, params) {
  const pad = 24, pw = W - pad * 2, ph = H - pad * 2;
  // pad background
  ctx.fillStyle = 'rgba(255,255,255,.02)'; ctx.fillRect(pad, pad, pw, ph);
  ctx.strokeStyle = C.grid; ctx.strokeRect(pad, pad, pw, ph);
  // grid
  ctx.strokeStyle = C.grid;
  ctx.beginPath(); ctx.moveTo(pad + pw / 2, pad); ctx.lineTo(pad + pw / 2, pad + ph); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad, pad + ph / 2); ctx.lineTo(pad + pw, pad + ph / 2); ctx.stroke();
  // axis labels
  ctx.fillStyle = C.muted; ctx.font = `7px ${C.font}`;
  ctx.textAlign = 'center'; ctx.fillText('STRUCTURE', pad + pw / 2, pad - 6);
  ctx.save(); ctx.translate(pad - 10, pad + ph / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('TIMBRE', 0, 0); ctx.restore();
  // puck
  const px = pad + (params.structureWeight ?? params.morphPosition ?? 0.5) * pw;
  const py = pad + (1 - (params.timbreBlend ?? 0.5)) * ph;
  // glow trail
  const grad = ctx.createRadialGradient(px, py, 0, px, py, 30);
  grad.addColorStop(0, 'rgba(139,92,246,.3)'); grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad; ctx.fillRect(px - 35, py - 35, 70, 70);
  // puck
  ctx.beginPath(); ctx.arc(px, py, 10, 0, Math.PI * 2);
  ctx.fillStyle = C.accent; ctx.fill();
  ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(139,92,246,.4)'; ctx.lineWidth = 2; ctx.stroke();
  // readout
  ctx.fillStyle = '#fff'; ctx.font = `8px ${C.font}`; ctx.textAlign = 'center';
  const sv = (params.structureWeight ?? params.morphPosition ?? 0.5).toFixed(2);
  const tv = (params.timbreBlend ?? 0.5).toFixed(2);
  ctx.fillText(`X:${sv}  Y:${tv}`, W / 2, H - 6);
}

// ═══════════════════════════════════════════════════════════════════════
// 12. PROMPT — text bar + response field
// ═══════════════════════════════════════════════════════════════════════
function drawPrompt(ctx, W, H, data, params) {
  // text input bar
  const bx = 20, by = 16, bw = W - 40, bh = 28;
  ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.fill();
  ctx.strokeStyle = 'rgba(139,92,246,.3)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.stroke();
  const prompt = params.prompt || 'describe the sound you want…';
  ctx.fillStyle = params.prompt ? C.text : C.muted; ctx.font = `11px "IBM Plex Sans",sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(prompt, bx + 14, by + 18);
  // response waveform/bars below
  if (data.freq) {
    const barY = by + bh + 20, barH = H - barY - 16, barsN = 40;
    const step = Math.floor(data.freq.length / barsN);
    for (let i = 0; i < barsN; i++) {
      let v = 0; for (let j = 0; j < step; j++) v += Math.max(0, data.freq[i * step + j] + 90); v /= step * 90;
      const bx2 = 20 + i * (W - 40) / barsN, bw2 = (W - 40) / barsN - 2, h = v * barH;
      ctx.fillStyle = `hsla(${260 + i * 2},70%,65%,${.3 + v * .5})`;
      ctx.fillRect(bx2, barY + barH - h, bw2, h);
    }
  }
  // keywords matched indicator
  ctx.fillStyle = C.accent; ctx.font = `bold 8px ${C.font}`; ctx.textAlign = 'right';
  ctx.fillText('KEYWORD → FFMPEG', W - 24, H - 6);
}

// ═══════════════════════════════════════════════════════════════════════
// 13. MACRO — themed scope per character effect
// ═══════════════════════════════════════════════════════════════════════
function drawMacro(ctx, W, H, data, params) {
  if (!data.time) { ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.fillRect(0, 0, W, H); return; }
  const mid = H / 2;
  // CRT-style scanlines
  ctx.strokeStyle = 'rgba(255,255,255,.015)'; ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 3) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // waveform (phosphor green like a CRT)
  const step = Math.max(1, Math.floor(data.time.length / W));
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const i = Math.min(x * step, data.time.length - 1);
    const y = mid - data.time[i] * H * 0.4;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 1.5; ctx.shadowColor = '#39ff14'; ctx.shadowBlur = 8; ctx.stroke();
  ctx.shadowBlur = 0;
  // ghost trail (dimmed, slightly offset)
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const i = Math.min(x * step + 200, data.time.length - 1);
    const y = mid - (data.time[i] || 0) * H * 0.35;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(57,255,20,.15)'; ctx.lineWidth = 1; ctx.stroke();
  // center line
  ctx.strokeStyle = 'rgba(57,255,20,.1)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();
}

// ═══════════════════════════════════════════════════════════════════════
// 14. DELIVERY — platform cards + loudness bar
// ═══════════════════════════════════════════════════════════════════════
function drawDelivery(ctx, W, H, data, params) {
  const plats = [
    { n: 'Spotify', lufs: -14, tp: -2, c: '#1DB954' }, { n: 'Apple', lufs: -16, tp: -1, c: '#fc3c44' },
    { n: 'YouTube', lufs: -14, tp: -1, c: '#ff0000' }, { n: 'Tidal', lufs: -14, tp: -1, c: '#00FFFF' },
    { n: 'Club', lufs: -8, tp: -0.1, c: '#ff6600' }, { n: 'CD', lufs: -14, tp: -0.3, c: '#ccc' },
  ];
  const cw = Math.min(90, (W - 40) / plats.length - 6), ch = 50;
  const startX = (W - plats.length * (cw + 6)) / 2, startY = 14;
  const selected = params.platform || 'spotify';
  plats.forEach((p, i) => {
    const x = startX + i * (cw + 6), y = startY;
    const isSel = p.n.toLowerCase() === selected.toLowerCase();
    ctx.fillStyle = isSel ? 'rgba(255,255,255,.08)' : 'rgba(255,255,255,.025)';
    ctx.strokeStyle = isSel ? p.c : 'rgba(255,255,255,.06)'; ctx.lineWidth = isSel ? 1.5 : 1;
    ctx.beginPath(); ctx.roundRect(x, y, cw, ch, 6); ctx.fill(); ctx.stroke();
    if (isSel) { ctx.shadowColor = p.c; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; }
    ctx.fillStyle = p.c; ctx.font = `bold 9px "IBM Plex Sans"`; ctx.textAlign = 'center';
    ctx.fillText(p.n, x + cw / 2, y + 15);
    ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.font = `8px ${C.font}`;
    ctx.fillText(p.lufs + ' LUFS', x + cw / 2, y + 28);
    ctx.fillText(p.tp + ' dBTP', x + cw / 2, y + 40);
  });
  // loudness bar
  const by = startY + ch + 16, bw = W - 60, bx = 30;
  ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.beginPath(); ctx.roundRect(bx, by, bw, 8, 4); ctx.fill();
  let rms = -60;
  if (data.time) { let s = 0; for (let i = 0; i < data.time.length; i++) s += data.time[i] ** 2; rms = s > 0 ? 10 * Math.log10(s / data.time.length) : -60; }
  const pct = Math.max(0, Math.min(1, (rms + 50) / 50));
  const mGrad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
  mGrad.addColorStop(0, C.green); mGrad.addColorStop(.6, C.yellow); mGrad.addColorStop(.85, C.orange); mGrad.addColorStop(1, C.red);
  ctx.fillStyle = mGrad; ctx.beginPath(); ctx.roundRect(bx, by, bw * pct, 8, 4); ctx.fill();
  // target line
  const tgt = plats.find(p => p.n.toLowerCase() === selected.toLowerCase())?.lufs ?? -14;
  const tx = bx + bw * Math.max(0, (tgt + 50) / 50);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tx, by - 4); ctx.lineTo(tx, by + 12); ctx.stroke();
  ctx.fillStyle = C.gridText; ctx.font = `7px ${C.font}`; ctx.textAlign = 'left'; ctx.fillText('-50', bx, by + 22);
  ctx.textAlign = 'center'; ctx.fillText(tgt + '', tx, by + 22);
  ctx.textAlign = 'right'; ctx.fillText('0', bx + bw, by + 22);
  // pass/fail
  const pass = Math.abs(rms - tgt) < 3;
  ctx.fillStyle = pass ? C.green : C.yellow; ctx.font = `bold 10px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText(pass ? '✓ PASS' : '⚠ CHECK', W / 2, by + 38);
}

// ═══════════════════════════════════════════════════════════════════════
// SPLIT-SPECTRO (enhance before/after)
// ═══════════════════════════════════════════════════════════════════════
function drawSplitSpectro(ctx, W, H, data, params) {
  drawSpectro(ctx, W, H, data, params);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W / 2, H);
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = `8px ${C.font}`; ctx.textAlign = 'center';
  ctx.fillText('BEFORE', W / 4, 14); ctx.fillStyle = 'rgba(34,211,238,.6)'; ctx.fillText('AFTER', W * 3 / 4, 14);
}

// ═══════════════════════════════════════════════════════════════════════
// VIZ ROUTER — picks renderer by viz type
// ═══════════════════════════════════════════════════════════════════════
const VIZ_MAP = {
  eq: drawEq, dynamics: drawDynamics, imager: drawImager, meters: drawMeters,
  spectrum: drawSpectrum, spectro: drawSpectro, wave: drawWave, vortex: drawVortex,
  paint: drawPaint, grain: drawGrain, xy: drawXY, prompt: drawPrompt,
  macro: drawMacro, delivery: drawDelivery, 'split-spectro': drawSplitSpectro,
};

window.VIZ_MAP = VIZ_MAP;
window.vizDraw = function(vizType, ctx, W, H, data, params) {
  const fn = VIZ_MAP[vizType] || drawSpectrum;
  fn(ctx, W, H, data, params);
};
