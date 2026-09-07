/**
 * loomTemplates — sample LOOM scores over the user's own catalogue.
 *
 * Songs are referenced by title fragment (`<just give up:bass>`); loading a
 * template puts its songs in the crate, which cuts them into shards on first
 * use. Two simple scores (one song each), two involved ones (a second song
 * folded in where it shares key or tempo). Every template must parse clean —
 * `npm run test:loom` checks that.
 */

export interface LoomTemplate {
  id: string;
  name: string;
  level: 'simple' | 'complex';
  /** Title fragments resolved against the library (see resolveEntryRef). */
  songs: string[];
  blurb: string;
  text: string;
  /** 'colony' scores load into the node mode; default is the plane. */
  mode?: 'plane' | 'colony';
}

export const LOOM_TEMPLATES: LoomTemplate[] = [
  {
    id: 'just-give-up-skeleton',
    name: 'Just Give Up — skeleton',
    level: 'simple',
    songs: ['just give up'],
    blurb: 'One song, three lanes: its own kick and hats on a sixteenth grid, a half-time bass, one vocal bar that re-rolls every lap.',
    text: `; Just Give Up — skeleton
; Its own drums re-cut on a 1/16 grid, bass at half time, a fresh vocal bar every lap.
bpm 143.5
key D#m

lane drums 1/16 x16
  .   .   .   .   .   .   ?50 .   | .   .   .   .   .   .   ?50 .
  <just give up:kick> . <just give up:hihat> . <just give up:snare> . <just give up:hihat> . | <just give up:kick> . <just give up:hihat> <just give up:kick> <just give up:snare> . <just give up:hihat> .

lane bass 1/8 x8
  <just give up:bass>:4 -  -  -  <just give up:bass>:4 -  -  -

lane vox 1/4 x4
  .    .    =gain-4 .
  <just give up:vocals>:4^ -  -  -
`,
  },
  {
    id: 'et-tu-machina-pulse',
    name: 'Et Tu Machina — pulse',
    level: 'simple',
    songs: ['et tu machina'],
    blurb: 'A 3-against-4 study: drums on sixteen steps, the "other" stem on twelve, so the two lanes drift and realign every three bars.',
    text: `; Et Tu Machina — pulse
; Two lanes of different lengths (x16 against x12): the polyrhythm realigns every 3 bars.
bpm 112.5
key Fm

lane drums 1/16 x16
  <et tu machina:kick> . . <et tu machina:hihat> | <et tu machina:kick> . <et tu machina:snare> . | <et tu machina:kick> . . <et tu machina:hihat> | <et tu machina:snare> . <et tu machina:hihat> <et tu machina:hihat>

lane other 1/16 x12
  .   .   .   =cut.3   .   .   .   =cut.8   .   .   .   .
  <et tu machina:other>:3 - - <et tu machina:other>:3 - - <et tu machina:other>:3 - - <et tu machina:other>:3 - -

lane bass 1/4 x4
  <et tu machina:bass>:2 - . <et tu machina:bass>^2
`,
  },
  {
    id: 'elements-thank-jeb-weave',
    name: 'The Elements × Thank Jeb — weave',
    level: 'complex',
    songs: ['elements - gantasmo', 'thank jeb'],
    blurb: 'Two songs that share 143.5 BPM and E minor. Cycle gates alternate whose drums lead, a chance-gated fill lane, locks duck the bass under the vocal, and a jump branch every fourth lap.',
    text: `; The Elements × Thank Jeb For Me — weave
; Same tempo, same key: the two songs trade material by lap. The master lane is 'lead'.
bpm 143.5
key Em

lane lead 1/16 x16
  !1,3:4 .  .  .  .  .  .  .  | !1,3:4 .  .  .  .  .  .  ?35
  <elements - gantasmo:kick> . <elements - gantasmo:hihat> . <elements - gantasmo:snare> . <elements - gantasmo:hihat> . | <elements - gantasmo:kick> . <elements - gantasmo:hihat> <elements - gantasmo:kick> <elements - gantasmo:snare> . <elements - gantasmo:hihat> ->fill

lane answer 1/16 x16
  !2,4:4 .  .  .  .  .  .  .  | !2,4:4 .  .  .  .  .  .  .
  <thank jeb:kick> . <thank jeb:hihat> <thank jeb:hihat> <thank jeb:snare> . <thank jeb:hihat> . | <thank jeb:kick> <thank jeb:kick> <thank jeb:hihat> . <thank jeb:snare> . <thank jeb:hihat> <thank jeb:hihat>

lane low 1/8 x8
  =gain-2 .  .  .  =gain-9,cut.35 .  .  .
  <elements - gantasmo:bass>:4 - - - <thank jeb:bass>:4 - - -

lane voice 1/4 x8
  .  .  .  .  ?60 .  .  .
  <elements - gantasmo:vocals>:4 - - - <thank jeb:vocals>:4^ - - -

lane pads 1/2 x4
  =cut.45,res4 .  +cut.3 .
  {role=other entry="elements - gantasmo" energy>0.6}:2 - {role=other entry="thank jeb" energy<0.5}:2 -

lane fill 1/16 x4 @target
  =gain-3 .  =gain-3 .
  <thank jeb:snare> <thank jeb:snare> <elements - gantasmo:snare> <elements - gantasmo:kick>
`,
  },
  {
    id: 'natures-tomb-glass-wings-arc',
    name: "Nature's Tomb ⟶ Glass Wings — arc",
    level: 'complex',
    songs: ['nature', 'glass wings normal'],
    blurb: "Nature's Tomb at 89 BPM as the ground (piano, guitar, bass in C minor), Drum of Glass Wings' vocal words dropped in by lyric search and pulled into key, an eight-lap energy arc through cycle gates, and a two-bar break that returns home.",
    text: `; Nature's Tomb → Drum of Glass Wings — arc
; The ground is Nature's Tomb (89 BPM, Cm). Glass Wings' words are found by lyric search and transposed to Cm.
; The arc: laps 1-2 sparse, 3-6 full, 7-8 the break lane.
bpm 89
key Cm

lane ground 1/8 x16
  .  .  .  .  .  .  .  .  | !3,4,5,6,7,8:8 .  .  .  .  .  .  ->break
  <nature:piano>:8 - - - - - - - | <nature:piano>:8 - - - - - - -

lane drums 1/16 x16
  !3,4,5,6:8 . . . . . . . | !3,4,5,6:8 . . . . . . ?50
  <nature:kick> . <nature:hihat> <nature:hihat> <nature:snare> . <nature:hihat> . | <nature:kick> . <nature:hihat> <nature:kick> <nature:snare> . <nature:hihat> <nature:snare>

lane ghost 1/16 x16
  !1,2,7,8:8 ?40 .  ?40 .  ?40 .  ?40 | !1,2,7,8:8 ?40 .  ?40 .  ?40 .  ?40
  .  <nature:hihat> .  <nature:hihat> .  <nature:hihat> .  <nature:hihat> | .  <nature:hihat> .  <nature:hihat> .  <nature:hihat> .  <nature:hihat>

lane bass 1/4 x8
  =gain-1 .  .  .  +gain-4 .  .  .
  <nature:bass>:4 - - - <nature:bass>:2 - <nature:bass>:2^2 -

lane guitar 1/2 x8
  !2,3,4,5,6:8 .  .  .  =cut.5,res3 .  .  .
  <nature:guitar>:4 - - - <nature:guitar>:4 - - -

lane words 1/4 x8
  !3,4,5,6,7,8:8 .  .  .  .  .  .  .
  {role=vocals entry="glass wings normal" text=you}:2 - . {role=vocals entry="glass wings normal" text=the}:2^ - . {role=vocals entry="glass wings normal" energy>0.6}:2^ -

lane break 1/8 x16 @target
  =gain-6,cut.25 .  .  .  .  .  .  .  | +cut.2 .  .  .  .  .  .  =gain0,cut1
  <nature:other>:8 - - - - - - - | <nature:piano>:4 - - - <nature:bass>:2 - <nature:kick> <nature:snare>
`,
  },
  {
    id: 'garden-of-forking-beats',
    name: 'Garden of Forking Beats — generative',
    level: 'complex',
    songs: [],
    blurb: 'No pinned songs: put anything on deck. A Euclidean kick under a Thue–Morse hat, a Life colony over the bass and vocal shards that breathes generation by generation (form AABA replays the A sections), a Fibonacci fill lane, a glissando lift and a tempo ramp from 118 to 132 over twelve laps. Grow or breed it from the GROW pane.',
    text: `; Garden of Forking Beats — every rail is a rule
; seed fixes the dice; form AABA makes laps 1,2,4 the same A and lap 3 the B; ramp lifts the tempo.
bpm 118
key follow
seed 2026
form AABA
ramp bpm 118 132 12

lane pulse 1/16 x16
  .  .  .  .  ?70 .  .  .  | .  .  .  .  !3,4:4 .  .  ->lift
  euclid(k s; hits=5 rotate=1) - - - - - - - - - - - - - - -

lane hats 1/16 x16
  =gain-8 .  .  .  .  .  .  .  | +gain2 .  .  .  .  .  .  .
  fractal(h . h c; kind=thue) - - - - - - - - - - - - - - -

lane colony 1/8 x16
  life(b v o; density=.35 rule=B3/S23) - - - - - - - - - - - - - - -

lane fill 1/16 x8 @target
  fib(s h) - - - - - - -

lane lift 1/4 x8 @target
  gliss(v; from=0 to=7) - - - accel(o; from=1 to=1.6) - - -

lane echoes 1/8 x16
  !2,3,4:4 .  .  .  .  .  .  .  | .  .  .  .  .  .  .  .
  echo(v; every=4 decay=5 depth=2) - - - - - - - - - - - v:4 - - -
`,
  },
  {
    id: 'zappa-colonies',
    name: 'Inca Roads — colonies in 7/8, 11/8 and 5/4',
    level: 'complex',
    mode: 'colony',
    songs: [],
    blurb: 'A colony score: the root breathes in 4/4 while a 7/8 cell (3+2+2), an 11/8 cell (3+3+3+2) at half tempo and a 5/4 cell (3+2) at 1.5× run inside it — each a graph of its own. Stem loops for drums and bass, a Life swarm on the words, Euclidean ticks on the hats. Any song on deck; stems get cut on first play.',
    text: `; Inca Roads — three colonies inside one, each with its own meter and tempo
; Root: 4/4. seven: 7/8 (3+2+2). eleven: 11/8 (3+3+3+2) at half tempo. five: 5/4 (3+2) at 1.5x.
bpm 112
key follow
seed 74
form AABA
swing .6
grain 8
grow .35 max=32
meter 4/4

loop drums = {role=drums beats=8} beats=8 hold
loop bass = b beats=4
loop word = v beats=1 gain=-2
rule ground = euclid(hits=3 steps=8)
rule swarm = life(steps=16 rows=4 density=.3)
gate some = ?55
mod low = =cut.3

colony seven meter=7/8 groups=3+2+2 {
  loop hat = h beats=1 gain=-6
  loop snap = s beats=1
  rule tick = euclid(hits=5 steps=7)
  rule off = fractal(steps=7 kind=thue)
  tick -> hat
  off -> snap on=1
}

colony eleven meter=11/8 groups=3+3+3+2 tempo=0.5 {
  loop pad = o beats=4 hold
  loop deep = b beats=2 transpose=-12
  rule slow = fib(steps=11)
  gate half = !1,3:4
  slow -> pad on=0
  slow -> half -> deep
}

colony five meter=5/4 groups=3+2 tempo=1.5 {
  loop kick = k beats=1
  loop tom = t beats=1
  rule run = euclid(hits=3 steps=5)
  rule roll = rand(steps=10 p=.4)
  run -> kick
  roll -> tom
}

ground -> drums
swarm -> bass on=0
swarm -> some -> low -> word
ground -> seven on=0
ground -> eleven on=0
swarm -> five on=1
`,
  },
];

export const loomTemplateById = (id: string): LoomTemplate | undefined => LOOM_TEMPLATES.find((t) => t.id === id);
