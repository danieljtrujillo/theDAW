/**
 * The inline permission / question card.
 *
 * Raised when the CLI emits a `control_request`. The child is BLOCKED until the
 * answer is POSTed back, so this card is the only way the turn continues.
 *
 * theDAW adds two things to the Foundry original:
 *  - a SELF-MODIFY banner. `policy.selfModify` means the agent is about to edit
 *    its OWN surface (assistant routes, orb-kit, RAG). That is named explicitly,
 *    the file is shown, and "Allow for session" is REMOVED — a self-edit is
 *    never remembered, so every one of them is a fresh, deliberate decision.
 *  - a countdown. It is display only: the BACKEND owns the auto-deny at 180s.
 *    Denying here too would race it and could answer a request the CLI has
 *    already been told about.
 */

import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Ban, Check, HelpCircle, ShieldAlert } from 'lucide-react';

import { controlSecondsLeft } from './display';
import type { ControlResponse, ControlScope, PendingControl } from '../stream/types';

export interface ControlAnswerHandler {
    (requestId: string, response: ControlResponse, scope: ControlScope): void;
}

const CARD_CLASSES =
    'mt-1 mb-1 w-full bg-primary/10 border border-primary/30 rounded-xl p-3 flex flex-col gap-2';
const BUTTON_BASE = 'px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors';

/** Live seconds remaining, refreshed once a second while the card is mounted. */
function Countdown({ createdAt }: { createdAt: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    const left = controlSecondsLeft(createdAt, now);
    return (
        <span className="text-[10px] text-zinc-500 tabular-nums" role="timer" aria-live="off">
            {left > 0 ? `auto-denies in ${left}s` : 'timed out'}
        </span>
    );
}

function SelfModifyBanner({ path, backendRestart }: { path: string | null; backendRestart: boolean }) {
    return (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2.5 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-300" aria-hidden="true" />
            <div className="flex flex-col gap-0.5 text-[11px] text-amber-100">
                <span className="font-semibold tracking-wide">SELF-MODIFY</span>
                <span className="text-amber-200/90">
                    The assistant is editing its own surface
                    {path ? (
                        <>
                            {': '}
                            <span className="font-mono break-all">{path}</span>
                        </>
                    ) : (
                        '.'
                    )}
                </span>
                {backendRestart && (
                    <span className="text-amber-200/90">The backend restarts after this edit.</span>
                )}
            </div>
        </div>
    );
}

export function ControlRequestCard({
    control,
    onAnswer,
}: {
    control: PendingControl;
    onAnswer: ControlAnswerHandler;
}) {
    if (control.toolName === 'AskUserQuestion') {
        return <AskQuestionCard control={control} onAnswer={onAnswer} />;
    }

    const selfModify = control.policy?.selfModify === true;
    const allow: ControlResponse = { behavior: 'allow', updatedInput: control.input ?? {} };

    return (
        <div className={CARD_CLASSES}>
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                    <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                    Permission requested
                </span>
                <Countdown createdAt={control.createdAt} />
            </div>

            {selfModify && (
                <SelfModifyBanner
                    path={control.policy?.selfModifyPath ?? null}
                    backendRestart={control.policy?.backendRestart === true}
                />
            )}

            <div className="text-[11px] text-zinc-300">
                The agent wants to use <span className="font-mono text-primary">{control.toolName}</span>
                {control.policy?.kind && control.policy.kind !== 'other' ? ` (${control.policy.kind})` : ''}.
            </div>
            {control.reason && <div className="text-[10px] text-zinc-500">{control.reason}</div>}

            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => onAnswer(control.requestId, allow, 'once')}
                    className={`${BUTTON_BASE} bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/30`}
                >
                    Allow once
                </button>
                {/* A self-modify is never remembered — no session scope offered. */}
                {!selfModify && (
                    <button
                        type="button"
                        onClick={() =>
                            onAnswer(
                                control.requestId,
                                control.suggestions?.length
                                    ? { ...allow, updatedPermissions: control.suggestions }
                                    : allow,
                                'session',
                            )
                        }
                        className={`${BUTTON_BASE} bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30`}
                    >
                        Allow for session
                    </button>
                )}
                <button
                    type="button"
                    onClick={() =>
                        onAnswer(
                            control.requestId,
                            { behavior: 'deny', message: 'The user denied this action in theDAW.' },
                            'once',
                        )
                    }
                    className={`${BUTTON_BASE} bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30 flex items-center gap-1.5`}
                >
                    <Ban className="w-3 h-3" aria-hidden="true" />
                    Deny
                </button>
            </div>
        </div>
    );
}

interface QuestionOption {
    label?: string;
    description?: string;
}

interface Question {
    question?: string;
    multiSelect?: boolean;
    options?: QuestionOption[];
}

export function AskQuestionCard({
    control,
    onAnswer,
}: {
    control: PendingControl;
    onAnswer: ControlAnswerHandler;
}) {
    const groupId = useId();
    const rawQuestions = control.input?.questions;
    const questions: Question[] = Array.isArray(rawQuestions) ? (rawQuestions as Question[]) : [];
    const [selected, setSelected] = useState<Record<number, string[]>>({});

    const toggle = (index: number, label: string, multi: boolean) => {
        setSelected((prev) => {
            const current = prev[index] ?? [];
            if (multi) {
                return {
                    ...prev,
                    [index]: current.includes(label)
                        ? current.filter((entry) => entry !== label)
                        : [...current, label],
                };
            }
            return { ...prev, [index]: [label] };
        });
    };

    const allAnswered = questions.length > 0 && questions.every((_, i) => (selected[i]?.length ?? 0) > 0);

    const submit = () => {
        // Echo the original questions back plus an answers map keyed by question
        // text, each value the joined selected label(s).
        const answers: Record<string, string> = {};
        questions.forEach((question, index) => {
            answers[String(question.question ?? index)] = (selected[index] ?? []).join(', ');
        });
        onAnswer(control.requestId, { behavior: 'allow', updatedInput: { questions, answers } }, 'once');
    };

    if (questions.length === 0) {
        return (
            <div className={CARD_CLASSES}>
                <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                        <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                        The agent is asking for input
                    </span>
                    <Countdown createdAt={control.createdAt} />
                </div>
                <button
                    type="button"
                    onClick={() =>
                        onAnswer(
                            control.requestId,
                            { behavior: 'allow', updatedInput: control.input ?? {} },
                            'once',
                        )
                    }
                    className={`self-start ${BUTTON_BASE} bg-primary/20 border border-primary/40 text-primary hover:bg-primary/30`}
                >
                    Dismiss
                </button>
            </div>
        );
    }

    return (
        <div className={`${CARD_CLASSES} gap-3`}>
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-primary">
                    <HelpCircle className="w-3.5 h-3.5" aria-hidden="true" />
                    The agent is asking
                    {questions.length > 1 ? ` ${questions.length} questions` : ' a question'}
                </span>
                <Countdown createdAt={control.createdAt} />
            </div>

            {questions.map((question, questionIndex) => {
                const labelId = `${groupId}-q${questionIndex}`;
                const multi = question.multiSelect === true;
                return (
                    <div key={questionIndex} className="flex flex-col gap-1.5">
                        <div id={labelId} className="text-xs text-zinc-100 font-medium">
                            {question.question}
                            {multi && <span className="ml-1 text-[10px] text-zinc-500">(choose any)</span>}
                        </div>
                        <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
                            {(question.options ?? []).map((option, optionIndex) => {
                                const label = String(option?.label ?? '');
                                const isSelected = (selected[questionIndex] ?? []).includes(label);
                                return (
                                    <button
                                        key={optionIndex}
                                        type="button"
                                        aria-pressed={isSelected}
                                        onClick={() => toggle(questionIndex, label, multi)}
                                        className={`text-left px-2.5 py-1.5 rounded-lg text-[11px] border cursor-pointer transition-colors flex items-start gap-2 ${
                                            isSelected
                                                ? 'bg-primary/30 border-primary/60 text-zinc-50'
                                                : 'bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10'
                                        }`}
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`mt-0.5 w-3.5 h-3.5 shrink-0 border flex items-center justify-center ${
                                                multi ? 'rounded' : 'rounded-full'
                                            } ${isSelected ? 'bg-primary border-primary' : 'border-zinc-500'}`}
                                        >
                                            {isSelected && <Check className="w-2.5 h-2.5 text-black" />}
                                        </span>
                                        <span className="flex flex-col">
                                            <span className="font-medium">{label}</span>
                                            {option?.description && (
                                                <span className="text-[10px] text-zinc-500">{option.description}</span>
                                            )}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            })}

            <button
                type="button"
                onClick={submit}
                disabled={!allAnswered}
                className={`self-end px-3.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                    allAnswered
                        ? 'bg-primary text-white hover:bg-primary/80 cursor-pointer'
                        : 'bg-white/5 text-zinc-600 cursor-not-allowed'
                }`}
            >
                Submit
            </button>
        </div>
    );
}
