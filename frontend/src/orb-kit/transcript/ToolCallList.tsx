/**
 * The tool activity block under an assistant turn.
 *
 * `ToolCallRow` dispatches by tool: Task/Agent (or anything that grew sub-calls)
 * → nested agent card, Edit/Write/MultiEdit/NotebookEdit → +/- diff, TodoWrite →
 * checklist, everything else → collapsible JSON. `AgentToolCard` recurses back
 * into `ToolCallRow`, which is why the two live in one file.
 */

import { useId, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';

import { countTools, isDiffableTool, extractDiffHunks, parseTodos } from './diff';
import { toolScaleClassFor } from './display';
import { DiffToolRow, PlainToolRow, TodoList } from './ToolRows';
import type { TextScale, ToolCallEntry } from '../stream/types';

/** How many distinct tool names the summary line lists before eliding. */
const SUMMARY_NAME_LIMIT = 4;

export function ToolCallList({
    toolCalls,
    textScale,
}: {
    toolCalls: ToolCallEntry[];
    textScale: TextScale;
}) {
    const { total, errors } = countTools(toolCalls);
    const names = Array.from(new Set(toolCalls.map((tool) => tool.name))).slice(0, SUMMARY_NAME_LIMIT);

    return (
        <div className={`mb-2 flex flex-col gap-1 ${toolScaleClassFor(textScale)}`}>
            {total > 1 && (
                <div className="flex items-center gap-2 px-1 text-[10px] text-zinc-500">
                    <Wrench className="w-3 h-3 text-primary shrink-0" aria-hidden="true" />
                    <span className="font-semibold text-zinc-400 shrink-0">
                        {total} tool{total === 1 ? '' : 's'}
                    </span>
                    <span className="truncate">
                        {names.join(', ')}
                        {toolCalls.length > SUMMARY_NAME_LIMIT ? '…' : ''}
                    </span>
                    {errors > 0 && (
                        <span className="text-red-400 shrink-0">
                            {errors} failed
                        </span>
                    )}
                </div>
            )}
            {toolCalls.map((tool, index) => (
                <ToolCallRow key={tool.toolId || index} tool={tool} />
            ))}
        </div>
    );
}

export function ToolCallRow({ tool }: { tool: ToolCallEntry }) {
    if (tool.name === 'Task' || tool.name === 'Agent' || (tool.subCalls && tool.subCalls.length > 0)) {
        return <AgentToolCard tool={tool} />;
    }
    // Only a TodoWrite that actually carries todos becomes a checklist; an empty
    // or still-accumulating input falls through to the plain JSON row.
    if (tool.name === 'TodoWrite' && parseTodos(tool.inputJson).length > 0) {
        return <TodoList inputJson={tool.inputJson} />;
    }
    if (isDiffableTool(tool.name) && extractDiffHunks(tool.name, tool.inputJson)) {
        return <DiffToolRow tool={tool} />;
    }
    return <PlainToolRow tool={tool} />;
}

/** Task/Agent spawn → nested card holding the sub-agent's own tool transcript. */
export function AgentToolCard({ tool }: { tool: ToolCallEntry }) {
    const [open, setOpen] = useState(true);
    const bodyId = useId();

    let input: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(tool.inputJson);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
        }
    } catch {
        input = {};
    }

    const description = String(input.description ?? input.prompt ?? 'sub-agent').slice(0, 80);
    const agentType = input.subagent_type ? String(input.subagent_type) : '';
    const subs = tool.subCalls ?? [];
    const { total, errors } = countTools(subs);
    const statusColor =
        tool.status === 'error' ? 'text-red-400' : tool.status === 'success' ? 'text-emerald-400' : 'text-primary';

    return (
        <div className="bg-primary/5 border border-primary/20 rounded-lg overflow-hidden text-[11px]">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={bodyId}
                className="w-full px-2.5 py-1.5 bg-primary/10 flex items-center gap-1.5 text-[10px] text-zinc-300 hover:text-zinc-100 cursor-pointer transition-colors text-left"
            >
                {open ? (
                    <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <Bot className={`w-3 h-3 shrink-0 ${statusColor}`} aria-hidden="true" />
                <span className="font-semibold shrink-0">{agentType || 'Agent'}</span>
                <span className="text-zinc-500 truncate">{description}</span>
                {tool.status === 'executing' && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" aria-label="running" />
                )}
                {total > 0 && (
                    <span className="text-zinc-500 shrink-0">
                        {total} tool{total === 1 ? '' : 's'}
                    </span>
                )}
                {errors > 0 && <span className="text-red-400 shrink-0">{errors} failed</span>}
            </button>
            {/* The container is always rendered so aria-controls resolves; the
                nested sub-agent rows are only built when it is open. */}
            <div
                id={bodyId}
                hidden={!open}
                className="border-t border-primary/15 bg-black/20 p-1.5 flex flex-col gap-1"
            >
                {open && (
                    <>
                        {subs.length > 0 ? (
                            subs.map((sub, index) => <ToolCallRow key={sub.toolId || index} tool={sub} />)
                        ) : (
                            <div className="px-1.5 py-1 text-[10px] text-zinc-600">running…</div>
                        )}
                        {tool.result && (
                            <div
                                className={`px-2 py-1.5 rounded text-[10px] whitespace-pre-wrap wrap-break-word ${
                                    tool.isError ? 'text-red-300 bg-red-500/10' : 'text-zinc-400 bg-white/5'
                                }`}
                            >
                                {tool.result.slice(0, 2000)}
                                {tool.result.length > 2000 ? '…' : ''}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
