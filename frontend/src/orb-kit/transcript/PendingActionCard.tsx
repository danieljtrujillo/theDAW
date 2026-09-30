/**
 * A T2_confirm DAW tool the agent invoked over the MCP relay, parked awaiting
 * Run or Skip.
 *
 * Unlike a `control_request`, this is OUR tier gate, not the CLI's: the tool
 * arrived as a `client_tool_call` and the browser simply has not executed it.
 * The relay call on the backend is blocked until one of these buttons answers
 * it — Run executes and reports the real result, Skip reports a decline — so
 * the model always learns what happened instead of guessing.
 */

import { Play, SkipForward, Zap } from 'lucide-react';

import type { PendingDawAction } from '../stream/types';

export function PendingActionCard({
    action,
    disabled = false,
    onRun,
    onSkip,
}: {
    action: PendingDawAction;
    disabled?: boolean;
    onRun: (callId: string) => void;
    onSkip: (callId: string) => void;
}) {
    return (
        <div className="mt-2 pt-2 border-t border-amber-500/30 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400 font-medium">
                <Zap className="w-3 h-3" aria-hidden="true" />
                <span>
                    Requires confirmation: <span className="font-mono">{action.type}</span>
                </span>
            </div>
            <div className="text-[11px] text-zinc-300">{action.description}</div>
            <div className="flex gap-2 mt-1">
                <button
                    type="button"
                    onClick={() => onRun(action.callId)}
                    disabled={disabled}
                    aria-label={`Run ${action.type}`}
                    className="flex-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 rounded py-1.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Play className="w-3 h-3" aria-hidden="true" />
                    Run
                </button>
                <button
                    type="button"
                    onClick={() => onSkip(action.callId)}
                    disabled={disabled}
                    aria-label={`Skip ${action.type}`}
                    className="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded py-1.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <SkipForward className="w-3 h-3" aria-hidden="true" />
                    Skip
                </button>
            </div>
        </div>
    );
}
