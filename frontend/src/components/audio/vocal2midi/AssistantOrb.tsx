import React, { useState, useRef, useEffect, useId } from 'react';
import { Check, Play, Send, Sparkles, Square, X } from 'lucide-react';
import type { ProcessingConfig, NoteEvent, ScaleType } from './types';
import { askAssistant, type AssistantContext } from './geminiAssistant';
import { FLYOUT_KEY, KEY_ON, KEY_REST, MINI_ICON_KEY, keyTone, useDockTip } from '../midiDockKit';

interface PianoRollControls {
    notes: NoteEvent[];
    bpm: number;
    rootNote: number;
    scale: ScaleType;
    isPlaying: boolean;
    onNotesChange: (notes: NoteEvent[]) => void;
    onBpmChange: (bpm: number) => void;
    onKeyChange: (rootNote: number, scale: ScaleType) => void;
    onPlay: () => void;
    onStop: () => void;
    onInstrumentChange: (instrument: string) => void;
}

interface AssistantOrbProps {
    currentConfig: ProcessingConfig;
    onConfigUpdate: (updates: Partial<ProcessingConfig>) => void;
    pianoRollControls: PianoRollControls;
}

/** Canned commands the chips type into the input. */
const QUICK_COMMANDS: { label: string; command: string }[] = [
    { label: 'Play', command: 'play the preview' },
    { label: 'Stop', command: 'stop' },
    { label: 'Quantize', command: 'quantize to 1/16' },
    { label: '+Octave', command: 'transpose up one octave' },
    { label: '140', command: 'set tempo to 140 bpm' },
    { label: 'Am', command: 'change to A minor' },
];

/**
 * The Vocal2MIDI "Architect" assistant. Its trigger is a mini key in the Voice
 * column header, drawn in the MIDI dock's key grammar (accent while the chat is
 * open, never a glow); the chat opens as a fixed card over the page.
 */
export const AssistantOrb: React.FC<AssistantOrbProps> = ({
    currentConfig,
    onConfigUpdate,
    pianoRollControls
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<{ role: 'user' | 'ai', text: string, actions?: string[] }[]>([
        { role: 'ai', text: "I am the Architect. I can control all settings, edit your MIDI notes, change tempo, transpose keys, and preview your work. What would you like me to do?" }
    ]);
    const [input, setInput] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const triggerTip = useDockTip({
        word: 'Architect',
        description: 'AI that changes the settings, notes, tempo and key',
        label: 'Architect assistant',
        expanded: isOpen,
    });
    const triggerRef = triggerTip.anchorRef;
    const panelId = `v2m-assistant-${useId().replace(/:/g, '')}`;

    // Keep the newest message in view. Scrolls the list itself: scrollIntoView
    // would also scroll the dock's own (overflow-hidden) ancestors.
    useEffect(() => {
        const list = listRef.current;
        if (isOpen && list) list.scrollTop = list.scrollHeight;
    }, [messages, isOpen]);

    useEffect(() => {
        if (isOpen) inputRef.current?.focus({ preventScroll: true });
    }, [isOpen]);

    const close = () => {
        setIsOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
    };

    const handleSend = async () => {
        if (!input.trim()) return;

        const userMsg = input;
        setInput('');
        setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
        setIsThinking(true);

        // Build context for the assistant
        const context: AssistantContext = {
            config: currentConfig,
            pianoRoll: {
                notes: pianoRollControls.notes,
                bpm: pianoRollControls.bpm,
                rootNote: pianoRollControls.rootNote,
                scale: pianoRollControls.scale,
                isPlaying: pianoRollControls.isPlaying
            }
        };

        const response = await askAssistant(userMsg, context);

        setIsThinking(false);

        // Track what actions were taken
        const actions: string[] = [];

        // Apply all the response updates
        if (response.configUpdates) {
            onConfigUpdate(response.configUpdates);
            actions.push('Updated settings');
        }

        if (response.notesUpdate !== undefined) {
            console.log('[AssistantOrb] Updating notes:', response.notesUpdate.length, 'notes');
            console.log('[AssistantOrb] First note before:', pianoRollControls.notes[0]);
            console.log('[AssistantOrb] First note after:', response.notesUpdate[0]);
            pianoRollControls.onNotesChange(response.notesUpdate);
            if (response.notesUpdate.length === 0) {
                actions.push('Cleared all notes');
            } else {
                actions.push(`Modified ${response.notesUpdate.length} notes`);
            }
        }

        if (response.bpmUpdate !== undefined) {
            pianoRollControls.onBpmChange(response.bpmUpdate);
            actions.push(`Set BPM to ${response.bpmUpdate}`);
        }

        if (response.keyUpdate) {
            pianoRollControls.onKeyChange(response.keyUpdate.rootNote, response.keyUpdate.scale);
            const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
            actions.push(`Changed key to ${noteNames[response.keyUpdate.rootNote % 12]} ${response.keyUpdate.scale}`);
        }

        if (response.playbackAction === 'play') {
            pianoRollControls.onPlay();
            actions.push('Started playback');
        } else if (response.playbackAction === 'stop') {
            pianoRollControls.onStop();
            actions.push('Stopped playback');
        }

        if (response.instrumentUpdate) {
            pianoRollControls.onInstrumentChange(response.instrumentUpdate);
            actions.push(`Changed instrument to ${response.instrumentUpdate}`);
        }

        setMessages(prev => [...prev, {
            role: 'ai',
            text: response.text,
            actions: actions.length > 0 ? actions : undefined
        }]);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const canSend = !!input.trim() && !isThinking;

    return (
        <>
            {/* The trigger: a mini key in the Voice header */}
            <button
                ref={triggerRef}
                type="button"
                onClick={() => (isOpen ? close() : setIsOpen(true))}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls={panelId}
                aria-label="Architect assistant"
                aria-describedby={triggerTip.describedBy}
                className={`${MINI_ICON_KEY} ${keyTone({ on: isOpen })}`}
            >
                <Sparkles aria-hidden="true" className="w-3 h-3" />
            </button>
            {triggerTip.tip}

            {/* Chat Interface. `inert` keeps the closed (faded) card out of Tab
                order and away from assistive tech. */}
            <div
                id={panelId}
                role="dialog"
                aria-label="Architect assistant"
                inert={!isOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        close();
                    }
                }}
                className={`fixed bottom-8 right-8 w-80 md:w-96 h-137.5 bg-zinc-900 border border-white/10 rounded-sm shadow-2xl z-50 flex flex-col transition-all duration-300 origin-bottom-right ${isOpen ? 'scale-100 opacity-100' : 'scale-90 opacity-0 pointer-events-none'
                    }`}
            >
                {/* Header */}
                <div className="px-3 py-2 border-b border-white/10 flex justify-between items-center bg-black/40">
                    <div className="flex items-center gap-2">
                        <Sparkles aria-hidden="true" size={14} className="text-[rgb(var(--et-accent))]" />
                        <span className="text-[12px] font-display font-extrabold uppercase et-ink">Architect</span>
                    </div>
                    <button
                        type="button"
                        onClick={close}
                        aria-label="Close the assistant"
                        title="Close"
                        className={`${MINI_ICON_KEY} ${KEY_REST}`}
                    >
                        <X aria-hidden="true" className="w-3 h-3" />
                    </button>
                </div>

                {/* Status Bar */}
                <div className="px-3 py-1.5 bg-black/20 border-b border-white/10 flex items-center justify-between text-[12px] font-semibold tabular-nums">
                    <span className="et-ink-3">
                        {pianoRollControls.notes.length} notes | {pianoRollControls.bpm} BPM
                    </span>
                    <span className={`inline-flex items-center gap-1 ${pianoRollControls.isPlaying ? 'text-[rgb(var(--et-accent))]' : 'et-ink-3'}`}>
                        {pianoRollControls.isPlaying ? <Play aria-hidden="true" className="w-3 h-3" /> : <Square aria-hidden="true" className="w-3 h-3" />}
                        {pianoRollControls.isPlaying ? 'PLAYING' : 'STOPPED'}
                    </span>
                </div>

                {/* Messages */}
                <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-3">
                    {messages.map((m, i) => (
                        <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] rounded-xs p-2.5 text-xs leading-relaxed ${m.role === 'user'
                                    ? 'bg-white/10 et-ink border border-white/10'
                                    : 'bg-black border border-white/10 et-ink-2'
                                }`}>
                                {m.text}
                                {m.actions && m.actions.length > 0 && (
                                    <div className="mt-2 pt-2 border-t border-white/5">
                                        <div className="text-[12px] font-semibold text-[rgb(var(--et-accent))]">
                                            {m.actions.map((action, j) => (
                                                <div key={j} className="flex items-start gap-1"><Check aria-hidden="true" className="w-3 h-3 shrink-0 mt-0.5" />{action}</div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                    {isThinking && (
                        <div className="flex justify-start" role="status" aria-label="Thinking">
                            <div className="bg-black border border-white/10 rounded-xs p-2.5 flex gap-1">
                                <div className="w-1.5 h-1.5 bg-[rgb(var(--et-accent))] rounded-full animate-bounce" />
                                <div className="w-1.5 h-1.5 bg-[rgb(var(--et-accent))] rounded-full animate-bounce delay-150" />
                                <div className="w-1.5 h-1.5 bg-[rgb(var(--et-accent))] rounded-full animate-bounce delay-300" />
                            </div>
                        </div>
                    )}
                </div>

                {/* Quick Commands: each types its command into the input */}
                <div className="px-3 py-2 border-t border-white/10 bg-black/20">
                    <div className="flex gap-1 flex-wrap">
                        {QUICK_COMMANDS.map((q) => (
                            <button
                                key={q.label}
                                type="button"
                                onClick={() => setInput(q.command)}
                                title={q.command}
                                className={`${FLYOUT_KEY} ${KEY_REST}`}
                            >
                                <span>{q.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Input */}
                <div className="p-3 border-t border-white/10 bg-black/40">
                    <div className="flex gap-2">
                        <label htmlFor="vocal2midi-assistant-input" className="sr-only">
                            Assistant command
                        </label>
                        <input
                            ref={inputRef}
                            type="text"
                            id="vocal2midi-assistant-input"
                            name="vocal2midi-assistant-input"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Try: 'make it faster' or 'change to E major'"
                            className="flex-1 bg-zinc-950 border border-white/10 rounded-xs px-3 py-2 text-xs et-ink focus:outline-none focus:border-[rgb(var(--et-accent)/0.6)] transition-colors"
                        />
                        <button
                            type="button"
                            onClick={handleSend}
                            disabled={!canSend}
                            aria-label="Send"
                            title="Send message"
                            className={`relative h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-xs border-b disabled:cursor-default disabled:*:opacity-40 ${canSend ? KEY_ON : KEY_REST}`}
                        >
                            <Send aria-hidden="true" className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
};
