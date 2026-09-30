/**
 * Compact per-turn accounting line under an assistant message:
 * tokens in/out · this turn's cost · duration · error flag.
 */

import type { TurnMeta } from '../stream/types';

export function TurnMetaLine({ meta }: { meta: TurnMeta }) {
    const parts: string[] = [];
    if (meta.inTokens) parts.push(`${(meta.inTokens / 1000).toFixed(1)}k in`);
    if (meta.outTokens) parts.push(`${(meta.outTokens / 1000).toFixed(1)}k out`);
    if (typeof meta.costUsd === 'number' && meta.costUsd > 0) parts.push(`$${meta.costUsd.toFixed(3)}`);
    if (typeof meta.durationMs === 'number') parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
    if (!parts.length && !meta.isError) return null;

    return (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-600">
            {meta.isError && <span className="text-red-400 font-semibold">error</span>}
            <span>{parts.join(' · ')}</span>
        </div>
    );
}
