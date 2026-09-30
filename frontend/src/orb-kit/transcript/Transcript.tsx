/**
 * The scrollable message list: message rows, the live streaming row, the
 * permission/question card. Returns a Fragment so it drops straight into the
 * panel's existing flex scroll container without changing the DOM shape.
 *
 * Ported from VST-Foundry-UI/src/components/orb/Transcript.tsx and restyled to
 * theDAW's panel (Tailwind classes instead of the Foundry's inline styles,
 * primary/violet accent instead of its red).
 *
 * Bubble metrics are the Foundry's: max-width 85%, 8px/12px padding, 12px
 * radius with a 4px tail corner on the speaker's side, a 24px avatar dot with a
 * caption under it, `white-space: pre-line` user text, and the blinking caret
 * on the live row. What is NOT copied is the Foundry's habit of stuffing
 * thinking, tools, meta and the action row INSIDE the bubble — see below.
 *
 * The behavioural fix this port carries: an assistant turn that produced only
 * tool activity renders its tool list and meta line with NO bubble and NO
 * Copy/Retry. theDAW previously coerced such a turn to `content || 'No
 * response.'` and hung an action row off the empty bubble.
 */

import { Fragment } from 'react';
import { Bot, Copy, Loader2, RotateCcw, User } from 'lucide-react';

import { CollapsibleReasoning } from './CollapsibleReasoning';
import { ControlRequestCard } from './ControlRequestCard';
import type { ControlAnswerHandler } from './ControlRequestCard';
// Extension required: ./markdown.ts and ./Markdown.tsx differ only by case, and
// resolvers try `.ts` first on a case-insensitive filesystem.
import { Markdown } from './Markdown.tsx';
import { PendingActionCard } from './PendingActionCard';
import { ToolCallList } from './ToolCallList';
import { TurnMetaLine } from './TurnMetaLine';
import { scaleClassFor, shouldShowMessageActions } from './display';
import type { ChatMessage, PendingControl, PendingDawAction, TextScale, ToolCallEntry } from '../stream/types';

export interface TranscriptProps {
    messages: ChatMessage[];
    textScale?: TextScale;
    isStreaming: boolean;
    /** Prose accumulated so far this turn. */
    liveText: string;
    liveThinking: string;
    liveToolCalls: ToolCallEntry[];
    /**
     * T2 DAW tools parked by the turn that is still streaming. They have no
     * message to sit under yet — the relay call blocks the CLI until they are
     * answered — so they render in the live row.
     */
    livePendingActions?: PendingDawAction[];
    pendingControls: PendingControl[];
    /** Transient status line. Never rendered as a message row. */
    statusText?: string | null;
    onCopyMessage: (text: string) => void;
    onRetry: () => void;
    onAnswerControl: ControlAnswerHandler;
    /** `messageId` is null for an action parked by the live, still-open turn. */
    onRunPendingAction: (messageId: string | null, callId: string) => void;
    onSkipPendingAction: (messageId: string | null, callId: string) => void;
}

/**
 * The Foundry's speaker column: a 24px dot with a small caption under it. The
 * dot keeps theDAW's own accent gradient and Bot glyph — only the layout is
 * copied.
 */
function AssistantAvatar({ isError = false }: { isError?: boolean }) {
    return (
        <div className="flex flex-col items-center gap-0.5 shrink-0">
            <div
                className={`w-6 h-6 rounded-full flex items-center justify-center ${
                    isError ? 'bg-red-500/20' : 'bg-linear-to-br from-primary to-pink-500'
                }`}
            >
                <Bot size={12} className={isError ? 'text-red-400' : 'text-white'} aria-hidden="true" />
            </div>
            <span className="text-[7px] tracking-wider whitespace-nowrap text-zinc-500" aria-hidden="true">
                GANTASMO
            </span>
        </div>
    );
}

export function Transcript({
    messages,
    textScale = 'sm',
    isStreaming,
    liveText,
    liveThinking,
    liveToolCalls,
    livePendingActions = [],
    pendingControls,
    statusText,
    onCopyMessage,
    onRetry,
    onAnswerControl,
    onRunPendingAction,
    onSkipPendingAction,
}: TranscriptProps) {
    const scaleClass = scaleClassFor(textScale);
    const lastId = messages[messages.length - 1]?.id;
    const hasLiveContent = !!(
        liveThinking ||
        liveText ||
        liveToolCalls.length > 0 ||
        livePendingActions.length > 0
    );

    return (
        <>
            {messages.map((message) => {
                const isUser = message.role === 'user';
                const hasText = message.text.trim().length > 0;
                const showActions = shouldShowMessageActions(message);

                return (
                    <div key={message.id} className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
                        {!isUser && <AssistantAvatar isError={message.isError} />}

                        <div className="flex flex-col gap-1.5 max-w-[85%] min-w-0">
                            {isUser ? (
                                <div
                                    className={`px-3 py-2 rounded-xl rounded-br-sm bg-primary text-white ${scaleClass}`}
                                >
                                    {/* The Foundry's user text is `white-space: pre-line`. */}
                                    <p className="whitespace-pre-line m-0">{message.text}</p>
                                </div>
                            ) : (
                                <Fragment>
                                    {message.thinking && <CollapsibleReasoning thinking={message.thinking} />}

                                    {message.toolCalls && message.toolCalls.length > 0 && (
                                        <ToolCallList toolCalls={message.toolCalls} textScale={textScale} />
                                    )}

                                    {/* The bubble exists only when there is prose in it. */}
                                    {hasText && (
                                        <div
                                            className={`px-3 py-2 rounded-xl rounded-bl-sm border ${scaleClass} ${
                                                message.isError
                                                    ? 'bg-red-500/10 border-red-500/30'
                                                    : 'bg-white/5 border-white/10'
                                            }`}
                                        >
                                            <Markdown text={message.text} />
                                        </div>
                                    )}

                                    {message.meta && <TurnMetaLine meta={message.meta} />}

                                    {/* Never disabled while streaming: the relay call
                                        that raised this card is what is blocking the
                                        turn, so the answer has to be reachable now. */}
                                    {message.pendingActions?.map((action) => (
                                        <PendingActionCard
                                            key={action.callId}
                                            action={action}
                                            onRun={(callId) => onRunPendingAction(message.id, callId)}
                                            onSkip={(callId) => onSkipPendingAction(message.id, callId)}
                                        />
                                    ))}

                                    {showActions && (
                                        <div className="flex items-center justify-end gap-2 text-[10px] text-zinc-500 opacity-60 hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                            <button
                                                type="button"
                                                onClick={() => onCopyMessage(message.text)}
                                                className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                                                title="Copy message"
                                                aria-label="Copy message"
                                            >
                                                <Copy size={10} aria-hidden="true" />
                                                <span>Copy</span>
                                            </button>
                                            {!isStreaming && message.id === lastId && (
                                                <button
                                                    type="button"
                                                    onClick={onRetry}
                                                    className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                                                    title="Retry this turn"
                                                    aria-label="Retry this turn"
                                                >
                                                    <RotateCcw size={10} aria-hidden="true" />
                                                    <span>Retry</span>
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </Fragment>
                            )}
                        </div>

                        {isUser && (
                            <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                                <User size={12} aria-hidden="true" />
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Live turn: thinking, tools and prose as they arrive. */}
            {isStreaming && (
                <div className="flex gap-2 justify-start">
                    <AssistantAvatar />
                    <div className="flex flex-col gap-1.5 max-w-[85%] min-w-0">
                        {liveThinking && <CollapsibleReasoning thinking={liveThinking} defaultOpen />}
                        {liveToolCalls.length > 0 && (
                            <ToolCallList toolCalls={liveToolCalls} textScale={textScale} />
                        )}
                        {liveText && (
                            <div className={`px-3 py-2 rounded-xl rounded-bl-sm bg-white/5 border border-white/10 ${scaleClass}`}>
                                <Markdown text={liveText} />
                                {/* The Foundry's `orb-chat__cursor`: a 2x14px caret
                                    blinking on step-end, styled in
                                    transcript/assistant-prose.css. */}
                                <span className="assistant-prose__cursor" aria-hidden="true" />
                            </div>
                        )}
                        {/* Parked T2 tools from the turn in flight. The CLI is
                            BLOCKED on each of these, so they must be answerable
                            here — waiting for `done` would deadlock the turn. */}
                        {livePendingActions.map((action) => (
                            <PendingActionCard
                                key={action.callId}
                                action={action}
                                onRun={(callId) => onRunPendingAction(null, callId)}
                                onSkip={(callId) => onSkipPendingAction(null, callId)}
                            />
                        ))}
                        {!hasLiveContent && (
                            <div className="px-3 py-2 rounded-xl rounded-bl-sm bg-white/5 border border-white/10 flex items-center gap-2">
                                <Loader2 className="w-3 h-3 animate-spin text-primary" aria-hidden="true" />
                                <span className="text-[10px] text-muted" role="status">
                                    {statusText || 'Thinking…'}
                                </span>
                            </div>
                        )}
                        {hasLiveContent && statusText && (
                            <span className="text-[10px] text-muted px-1" role="status">
                                {statusText}
                            </span>
                        )}
                    </div>
                </div>
            )}

            {/* The CLI is BLOCKED on each of these until it is answered. */}
            {pendingControls.map((control) => (
                <ControlRequestCard key={control.requestId} control={control} onAnswer={onAnswerControl} />
            ))}
        </>
    );
}
