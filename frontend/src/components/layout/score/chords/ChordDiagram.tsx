import React from 'react';
import { chordLabel, type ChordShape } from '../../../../lib/chordShapes';

export interface ChordDiagramProps {
  shape: ChordShape;
  /** Number of strings in the tuning (the shape's frets array length). */
  strings: number;
  /** Chord symbol the shape voices, e.g. 'Am7' (aria label + finger colours). */
  label: string;
  size?: 'sm' | 'lg';
}

/** ViewBox is drawn at the small size; the large size scales it 2x. */
const VIEW_W = 64;
const VIEW_H = 80;
const SIZES: Record<NonNullable<ChordDiagramProps['size']>, { w: number; h: number }> = {
  sm: { w: 64, h: 80 },
  lg: { w: 128, h: 160 },
};

/** Grid geometry in viewBox units. */
const FRETS_SHOWN = 5;
const GRID_LEFT = 14;
const GRID_RIGHT = 58;
const GRID_TOP = 16;
const GRID_BOTTOM = 76;
const FRET_SPACING = (GRID_BOTTOM - GRID_TOP) / FRETS_SHOWN;
const MARKER_ROW_Y = 8.5;

const DOT_FILL = '#f4f4f5'; // zinc-100
const FINGER_INK = '#0a080f'; // the app's chrome black, readable on the dot
const OPEN_STROKE = '#d4d4d8'; // zinc-300
const MUTE_STROKE = '#a1a1aa'; // zinc-400

/**
 * A chord box like the ones printed above a lead sheet: strings vertical, low
 * string at the left, five frets, a thick nut in open position or a "fr N"
 * marker when the shape sits up the neck, X/O row for muted and open strings,
 * dots carrying the finger number, and a barre as one rounded bar.
 *
 * Pure SVG with role="img"; the aria label is chordLabel(label, shape), e.g.
 * "F major, 133211 (barre fret 1)", so a screen reader gets the voicing too.
 */
export const ChordDiagram: React.FC<ChordDiagramProps> = ({ shape, strings, label, size = 'sm' }) => {
  const n = Math.max(1, Math.floor(strings));
  const dims = SIZES[size];
  const stringSpacing = n > 1 ? (GRID_RIGHT - GRID_LEFT) / (n - 1) : 0;
  const xOf = (s: number): number => (n > 1 ? GRID_LEFT + s * stringSpacing : (GRID_LEFT + GRID_RIGHT) / 2);
  const openPosition = shape.baseFret <= 1;
  const firstFret = openPosition ? 1 : shape.baseFret;
  /** Row (0..FRETS_SHOWN-1) a fret sits in; clamped so a stray fret stays on the box. */
  const rowOf = (fret: number): number => Math.min(FRETS_SHOWN - 1, Math.max(0, fret - firstFret));
  const yOfFret = (fret: number): number => GRID_TOP + (rowOf(fret) + 0.5) * FRET_SPACING;
  const dotR = Math.max(2.2, Math.min(FRET_SPACING * 0.34, n > 1 ? stringSpacing * 0.42 : FRET_SPACING * 0.34));
  const fingerFont = dotR * 1.35;

  const frets = shape.frets.slice(0, n);
  const fingers = shape.fingers.slice(0, n);
  const barre = shape.barre && shape.barre.fret >= firstFret ? shape.barre : undefined;
  const inBarre = (s: number): boolean =>
    !!barre && s >= barre.from && s <= barre.to && frets[s] === barre.fret;

  const fretLines: number[] = [];
  for (let i = 0; i <= FRETS_SHOWN; i += 1) fretLines.push(GRID_TOP + i * FRET_SPACING);

  return (
    <svg
      role="img"
      aria-label={chordLabel(label, shape)}
      width={dims.w}
      height={dims.h}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="block text-zinc-200 select-none"
      style={{ color: '#e4e4e7' }}
    >
      {/* Frets (horizontal). The nut is the thick top line in open position. */}
      {fretLines.map((y, i) => (
        <line
          key={`f${i}`}
          x1={GRID_LEFT}
          x2={GRID_RIGHT}
          y1={y}
          y2={y}
          stroke="currentColor"
          strokeWidth={i === 0 && openPosition ? 2.6 : 0.8}
          strokeLinecap="square"
          opacity={i === 0 && openPosition ? 1 : 0.7}
        />
      ))}
      {/* Strings (vertical), low string at the left. */}
      {frets.map((_, s) => (
        <line
          key={`s${s}`}
          x1={xOf(s)}
          x2={xOf(s)}
          y1={GRID_TOP}
          y2={GRID_BOTTOM}
          stroke="currentColor"
          strokeWidth={0.8}
          opacity={0.7}
        />
      ))}
      {/* Position marker when the box does not start at the nut. */}
      {!openPosition && (
        <text
          x={GRID_LEFT - 2.5}
          y={GRID_TOP + FRET_SPACING * 0.5}
          textAnchor="end"
          dominantBaseline="central"
          fontSize={5.2}
          fontFamily="ui-monospace, monospace"
          fill="currentColor"
        >
          {`${firstFret}fr`}
        </text>
      )}
      {/* X / O row above the nut. */}
      {frets.map((f, s) =>
        f < 0 ? (
          <g key={`x${s}`} stroke={MUTE_STROKE} strokeWidth={1} strokeLinecap="round">
            <line x1={xOf(s) - 2.2} x2={xOf(s) + 2.2} y1={MARKER_ROW_Y - 2.2} y2={MARKER_ROW_Y + 2.2} />
            <line x1={xOf(s) - 2.2} x2={xOf(s) + 2.2} y1={MARKER_ROW_Y + 2.2} y2={MARKER_ROW_Y - 2.2} />
          </g>
        ) : f === 0 ? (
          <circle
            key={`o${s}`}
            cx={xOf(s)}
            cy={MARKER_ROW_Y}
            r={2.3}
            fill="none"
            stroke={OPEN_STROKE}
            strokeWidth={0.9}
          />
        ) : null,
      )}
      {/* Barre: one rounded bar across its string range. */}
      {barre && (
        <g>
          <rect
            x={xOf(barre.from) - dotR}
            y={yOfFret(barre.fret) - dotR}
            width={xOf(barre.to) - xOf(barre.from) + dotR * 2}
            height={dotR * 2}
            rx={dotR}
            ry={dotR}
            fill={DOT_FILL}
          />
          <text
            x={(xOf(barre.from) + xOf(barre.to)) / 2}
            y={yOfFret(barre.fret)}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fingerFont}
            fontWeight={700}
            fontFamily="ui-monospace, monospace"
            fill={FINGER_INK}
          >
            1
          </text>
        </g>
      )}
      {/* Fretted dots with the finger number inside. */}
      {frets.map((f, s) => {
        if (f <= 0 || inBarre(s)) return null;
        const finger = fingers[s] ?? 0;
        return (
          <g key={`d${s}`}>
            <circle cx={xOf(s)} cy={yOfFret(f)} r={dotR} fill={DOT_FILL} />
            {finger > 0 && (
              <text
                x={xOf(s)}
                y={yOfFret(f)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fingerFont}
                fontWeight={700}
                fontFamily="ui-monospace, monospace"
                fill={FINGER_INK}
              >
                {finger}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

export default ChordDiagram;
