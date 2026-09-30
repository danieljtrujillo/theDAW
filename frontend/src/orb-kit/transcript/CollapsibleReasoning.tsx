/**
 * Extended-thinking output, folded away behind a disclosure button.
 * Ported from the Foundry transcript; accent recoloured to theDAW's primary.
 */

import { useId, useState } from 'react';
import { ChevronDown, ChevronUp, Cpu } from 'lucide-react';

export function CollapsibleReasoning({
    thinking,
    defaultOpen = false,
}: {
    thinking: string;
    defaultOpen?: boolean;
}) {
    const [isExpanded, setIsExpanded] = useState(defaultOpen);
    const bodyId = useId();

    return (
        <div className="mb-2 bg-black/30 border border-white/10 rounded-lg overflow-hidden flex flex-col font-mono text-[11px] leading-relaxed">
            <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                aria-controls={bodyId}
                className="w-full px-2.5 py-1.5 bg-white/5 flex items-center justify-between text-[10px] text-zinc-500 hover:text-zinc-300 font-sans cursor-pointer transition-colors"
            >
                <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-primary" aria-hidden="true" />
                    {isExpanded ? 'Hide thought process' : 'View thought process'}
                </span>
                {isExpanded ? (
                    <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                    <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                )}
            </button>

            {/* Always rendered, toggled with `hidden`: aria-controls must point at
                an element that EXISTS, or assistive tech resolves it to nothing. */}
            <div
                id={bodyId}
                hidden={!isExpanded}
                className="p-2.5 text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-line border-t border-white/5 bg-black/20 select-all"
            >
                {thinking}
            </div>
        </div>
    );
}
