import React, { useRef, useState } from 'react';
import { Sparkles, Mic, Wand2, Guitar } from 'lucide-react';
import { useSunoStore } from './sunoStore';
import { HoverTip } from '../components/ui/Tooltip';

/**
 * SunoModeFields — the mode-specific form body. Mirrors the backend's per-mode
 * field rules:
 *   Simple : description (required), title?, voice?
 *   Custom : style (required), lyrics? | instrumental, title?, voice?
 *   Cover  : sourceId (required), style?, lyrics?, voice?
 *   Mashup : sourceId + additionalAudioId (required), style?, lyrics?, title? (NO voice)
 */

// Preset voices from the hackathon API (only these 3 are allowed).
const VOICES = [
  { id: '5b915c6d-8d96-416c-9755-eba65868cfef', name: 'Preset A', description: 'Female voice' },
  { id: 'c036ce3a-55e4-4690-9b8d-4516b37a96d5', name: 'Preset B', description: 'Weird kid voice' },
  { id: '27f5465b-73c3-4134-b11e-70b0bd571c6c', name: 'Preset C', description: 'Low male voice' },
];

const STYLE_PRESETS: { label: string; value: string }[] = [
  { label: 'Synthwave', value: 'synthwave, retro, driving synths, 80s' },
  { label: 'Lo-fi', value: 'lo-fi hip hop, mellow piano, jazzy, rainy night' },
  { label: 'Dreampop', value: 'dreampop, reverb-heavy guitars, ethereal' },
  { label: 'Trap', value: 'trap, hard 808s, dark, aggressive hi-hats' },
  { label: 'Folk', value: 'acoustic folk, fingerpicked guitar, warm' },
  { label: 'EDM', value: 'EDM, progressive house, euphoric build' },
  { label: 'R&B', value: 'R&B, smooth, soulful vocals, groove' },
  { label: 'Rock', value: 'alternative rock, distorted guitars, anthemic' },
  { label: 'Jazz', value: 'jazz, swing, saxophone solo, smoky lounge' },
  { label: 'Ambient', value: 'ambient, atmospheric pads, meditative, texture' },
];

const LYRIC_TAGS = ['[Verse]', '[Chorus]', '[Bridge]', '[Pre-Chorus]', '[Intro]', '[Outro]', '[Hook]'];

const Label: React.FC<{ text: string; optional?: boolean; hint?: string; tip?: string }> = ({
  text,
  optional,
  hint,
  tip,
}) => (
  <div className="flex flex-col gap-0.5 mb-1">
    <span className="mono-label text-[9px]! flex items-center gap-1.5">
      {tip ? <HoverTip text={tip}>{text}</HoverTip> : text}
      {optional && <span className="text-[8px] text-zinc-600 normal-case">optional</span>}
    </span>
    {hint && <span className="text-[8px] text-zinc-600 font-mono normal-case">{hint}</span>}
  </div>
);

/** StyleInput — a style text field with a presets popover, themed to StableDAW. */
const StyleInput: React.FC<{ optional?: boolean }> = ({ optional }) => {
  const style = useSunoStore((s) => s.style);
  const patch = useSunoStore((s) => s.patch);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Label
        text="Style"
        optional={optional}
        hint="Comma-separated: genre, instruments, mood, tempo."
        tip="The sonic recipe for the track — list genre, instruments, mood and tempo, comma-separated. Use the sparkle button for presets."
      />
      <div className="relative">
        <input
          className="compact-input w-full pr-7"
          placeholder="dreampop, reverb-heavy guitars, melancholic"
          value={style}
          onChange={(e) => patch({ style: e.target.value })}
        />
        <HoverTip text="Insert a ready-made style preset to fill or append to the style field.">
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-purple-300"
            onClick={() => setOpen((v) => !v)}
            type="button"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        </HoverTip>
      </div>
      {open && (
        <div className="mt-1.5 p-2 hardware-card flex flex-wrap gap-1">
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="mono-tag bg-white/5! text-zinc-300! hover:bg-purple-500/15!"
              onClick={() => {
                patch({ style: style ? `${style}, ${p.value}` : p.value });
                setOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** LyricsInput — textarea with section-tag insert chips. */
const LyricsInput: React.FC<{ optional?: boolean; hint?: string; placeholder?: string }> = ({
  optional,
  hint,
  placeholder,
}) => {
  const lyrics = useSunoStore((s) => s.lyrics);
  const patch = useSunoStore((s) => s.patch);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const insert = (tag: string) => {
    const ta = ref.current;
    if (!ta) {
      patch({ lyrics: lyrics + (lyrics ? '\n' : '') + tag + '\n' });
      return;
    }
    const start = ta.selectionStart;
    const before = lyrics.slice(0, start);
    const after = lyrics.slice(ta.selectionEnd);
    const ins = (before && !before.endsWith('\n') ? '\n' : '') + tag + '\n';
    patch({ lyrics: before + ins + after });
    setTimeout(() => {
      ta.selectionStart = ta.selectionEnd = start + ins.length;
      ta.focus();
    }, 0);
  };

  return (
    <div>
      <Label
        text="Lyrics"
        optional={optional}
        hint={hint}
        tip="The words Suno sings. Use the section chips to mark [Verse], [Chorus], etc. Leave empty for an instrumental."
      />
      <div className="flex flex-wrap gap-1 mb-1.5">
        {LYRIC_TAGS.map((t) => (
          <button
            key={t}
            type="button"
            className="mono-tag bg-white/5! text-zinc-500! hover:text-purple-300!"
            onClick={() => insert(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <textarea
        ref={ref}
        className="compact-input w-full min-h-32 resize-y font-mono text-[11px] leading-relaxed"
        placeholder={
          placeholder ??
          '[Verse]\nWalking through the static glow\n\n[Chorus]\nWe are the signal, we are the noise'
        }
        value={lyrics}
        onChange={(e) => patch({ lyrics: e.target.value })}
      />
    </div>
  );
};

const VoicePicker: React.FC = () => {
  const voiceId = useSunoStore((s) => s.voiceId);
  const patch = useSunoStore((s) => s.patch);
  // Compact tile: icon + short name; the longer description lives in the tooltip.
  const Tile: React.FC<{ id: string; icon: React.ReactNode; name: string; tip: string }> = ({
    id,
    icon,
    name,
    tip,
  }) => {
    const active = voiceId === id;
    return (
      <HoverTip text={tip}>
        <button
          type="button"
          onClick={() => patch({ voiceId: id })}
          className={`w-full flex flex-col items-center justify-center gap-1 px-1 py-2 rounded-lg border transition-all
            ${active ? 'bg-purple-600/20 border-purple-500/50 text-purple-200' : 'bg-white/[0.02] border-white/5 text-zinc-500 hover:text-zinc-300 hover:border-white/15'}`}
        >
          {icon}
          <span className="text-[8px] font-black uppercase tracking-wider">{name}</span>
        </button>
      </HoverTip>
    );
  };
  return (
    <div>
      <Label
        text="Voice"
        optional
        hint="Auto lets the model pick based on style & lyrics."
        tip="The singing voice for vocal tracks. Auto lets Suno choose; or pin one of the preset voices."
      />
      <div className="grid grid-cols-4 gap-1.5 [&>span]:w-full">
        <Tile
          id=""
          icon={<Wand2 className="w-4 h-4" />}
          name="Auto"
          tip="Let Suno choose the most fitting voice for your style and lyrics."
        />
        {VOICES.map((v) => (
          <Tile
            key={v.id}
            id={v.id}
            icon={<Mic className="w-4 h-4" />}
            name={v.name.replace('Preset ', '')}
            tip={`${v.name} — ${v.description.toLowerCase()}.`}
          />
        ))}
      </div>
    </div>
  );
};

/** The mode-specific form body. */
export const SunoModeFields: React.FC = () => {
  const mode = useSunoStore((s) => s.mode);
  const title = useSunoStore((s) => s.title);
  const description = useSunoStore((s) => s.description);
  const instrumental = useSunoStore((s) => s.instrumental);
  const sourceId = useSunoStore((s) => s.sourceId);
  const additionalAudioId = useSunoStore((s) => s.additionalAudioId);
  const patch = useSunoStore((s) => s.patch);

  return (
    <div className="flex flex-col gap-3">
      {/* Title — Simple / Custom / Mashup (not Cover, which inherits the source title) */}
      {mode !== 'cover' && (
        <div>
          <Label text="Title" optional tip="A name for your track. Leave blank and Suno will name it for you." />
          <input
            className="compact-input w-full"
            placeholder="My awesome track"
            value={title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </div>
      )}

      {mode === 'simple' && (
        <div>
          <Label
            text="Description"
            hint="Describe vibe, genre, mood, topic. AI writes lyrics + style."
            tip="Plain-language brief for the whole song — Suno turns this into both the lyrics and the musical style."
          />
          <textarea
            className="compact-input w-full min-h-24 resize-y"
            placeholder="upbeat synthwave track about driving through Tokyo at night"
            value={description}
            onChange={(e) => patch({ description: e.target.value })}
          />
        </div>
      )}

      {mode === 'custom' && (
        <>
          <StyleInput />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={instrumental}
              onChange={(e) => patch({ instrumental: e.target.checked })}
              className="accent-purple-500"
            />
            <span className="text-[10px] text-zinc-300 flex items-center gap-1.5">
              <Guitar className="w-3 h-3 text-zinc-500" />
              <HoverTip text="Generate music with no vocals. When on, the lyrics field is hidden and ignored.">
                Instrumental (no vocals)
              </HoverTip>
            </span>
          </label>
          {!instrumental && <LyricsInput />}
        </>
      )}

      {mode === 'cover' && (
        <>
          <div>
            <Label
              text="Source Clip ID"
              hint="A Suno clip you generated. Use a track's 'Cover' button, or paste an id."
              tip="The Suno clip to re-style. Must be a track you own — paste its id or use a library track’s Cover button to prefill."
            />
            <input
              className="compact-input w-full font-mono text-[11px]"
              placeholder="6e2b0f3a-…"
              value={sourceId}
              onChange={(e) => patch({ sourceId: e.target.value })}
            />
          </div>
          <StyleInput optional />
          <LyricsInput optional hint="Leave empty for an instrumental cover." placeholder="Leave empty for instrumental cover" />
        </>
      )}

      {mode === 'mashup' && (
        <>
          <div>
            <Label
              text="Source Clip ID"
              hint="First clip — the base of the mashup."
              tip="The base clip of the mashup — one of your own Suno tracks. Paste its id."
            />
            <input
              className="compact-input w-full font-mono text-[11px]"
              placeholder="6e2b0f3a-…"
              value={sourceId}
              onChange={(e) => patch({ sourceId: e.target.value })}
            />
          </div>
          <div>
            <Label
              text="Second Clip ID"
              hint="Blended with the source."
              tip="The second clip blended into the base — another Suno track you own. Paste its id."
            />
            <input
              className="compact-input w-full font-mono text-[11px]"
              placeholder="9a9e1da2-…"
              value={additionalAudioId}
              onChange={(e) => patch({ additionalAudioId: e.target.value })}
            />
          </div>
          <StyleInput optional />
          <LyricsInput optional hint="Leave empty for an instrumental mashup." placeholder="Leave empty for instrumental mashup" />
        </>
      )}

      {/* Voice — every mode except mashup (the API rejects voice on mashup). */}
      {mode !== 'mashup' && <VoicePicker />}
    </div>
  );
};
