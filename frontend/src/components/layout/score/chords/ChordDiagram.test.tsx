/**
 * Render smoke test for ChordDiagram (node, no DOM): the SVG carries the
 * accessible label, the nut vs "fr N" marker follows baseFret, X/O markers and
 * finger dots appear per string, and a barre draws as one rounded bar.
 *
 *   cd frontend && npx tsx src/components/layout/score/chords/ChordDiagram.test.tsx
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bestShapes, chordLabel, makeChordSpec } from '../../../../lib/chordShapes.ts';
import { ChordDiagram } from './ChordDiagram.tsx';

const GUITAR = [40, 45, 50, 55, 59, 64];

const render = (el: React.ReactElement): string => renderToStaticMarkup(el);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

// C major open shape: x32010 -> one X, two O, three dots, thick nut, no barre.
{
  const [shape] = bestShapes('guitar-standard', GUITAR, makeChordSpec(0, [4, 7]));
  assert.ok(shape, 'C major has a shape');
  assert.deepEqual(shape.frets, [-1, 3, 2, 0, 1, 0]);
  const html = render(<ChordDiagram shape={shape} strings={6} label="C" size="lg" />);
  assert.ok(html.includes('role="img"'));
  assert.ok(html.includes(`aria-label="${chordLabel('C', shape)}"`));
  assert.ok(html.includes('width="128"') && html.includes('height="160"'), 'lg is 128x160');
  assert.equal(count(html, 'stroke-width="2.6"'), 1, 'thick nut in open position');
  assert.ok(!html.includes('fr</text>'), 'no position marker at the nut');
  // 6 string lines + 6 fret lines; the X is two crossed lines.
  assert.equal(count(html, '<circle'), 2 + 3, 'two open-string rings + three finger dots');
  assert.equal(count(html, '<rect'), 0, 'no barre');
  assert.ok(html.includes('>1</text>') && html.includes('>2</text>') && html.includes('>3</text>'), 'finger numbers');
}

// F major barre: 133211 -> a rect for the barre, an "fr" marker is NOT shown
// (baseFret 1 still draws the nut).
{
  const shapes = bestShapes('guitar-standard', GUITAR, makeChordSpec(5, [4, 7]));
  const barre = shapes.find((s) => s.barre);
  assert.ok(barre, 'F has a barre voicing');
  const html = render(<ChordDiagram shape={barre} strings={6} label="F" />);
  assert.equal(count(html, '<rect'), 1, 'barre drawn as one rect');
  assert.ok(html.includes('width="64"') && html.includes('height="80"'), 'sm is 64x80');
}

// A shape up the neck shows the position marker instead of a nut.
{
  const shapes = bestShapes('guitar-standard', GUITAR, makeChordSpec(8, [4, 7])); // Ab
  const high = shapes.find((s) => s.baseFret > 1);
  assert.ok(high, 'Ab has a voicing above the nut');
  const html = render(<ChordDiagram shape={high} strings={6} label="Ab" />);
  assert.ok(html.includes(`${high.baseFret}fr</text>`), 'fr N marker present');
  assert.equal(count(html, 'stroke-width="2.6"'), 0, 'no thick nut up the neck');
}

// Four-string ukulele diagram renders with four strings.
{
  const UKE = [67, 60, 64, 69];
  const [shape] = bestShapes('ukulele-standard', UKE, makeChordSpec(0, [4, 7]));
  assert.ok(shape, 'ukulele C has a shape');
  const html = render(<ChordDiagram shape={shape} strings={4} label="C" />);
  // 4 string lines + 6 fret lines = 10 <line> elements plus 2 per X marker.
  const xs = shape.frets.filter((f) => f < 0).length;
  assert.equal(count(html, '<line'), 10 + 2 * xs);
}

console.log('ChordDiagram render test passed');
