/**
 * Leaf tool renderers: the default JSON row, the +/- diff row, and the
 * TodoWrite checklist. Ported from the Foundry transcript; the recursive
 * Task/Agent card lives in ToolCallList.tsx so these stay dependency-free.
 */

import type { ReactElement } from 'react';
import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, ListTodo, Loader2, Pencil, Wrench } from 'lucide-react';

import { diffLines, extractDiffHunks, parseTodos } from './diff';
import type { DiffRow } from './diff';
import type { ToolCallEntry } from '../stream/types';

/** How many diff lines are rendered before the rest is summarised. */
const MAX_DIFF_ROWS = 400;

function statusIconClass(tool: ToolCallEntry): string {
    if (tool.status === 'error') return 'text-red-400';
    if (tool.status === 'success') return 'text-emerald-400';
    return 'text-primary';
}

/** Default renderer: wrench + name + collapsible pretty-JSON input + result. */
export function PlainToolRow({ tool }: { tool: ToolCallEntry }) {
    const [open, setOpen] = useState(false);
    const bodyId = useId();

    let prettyInput = tool.inputJson;
    try {
        prettyInput = JSON.stringify(JSON.parse(tool.inputJson), null, 2);
    } catch {
        /* partial or non-JSON input — show it raw */
    }

    const resultText = tool.result ?? '';
    const firstLine = resultText.split('\n')[0].slice(0, 100);
    const truncated = resultText.length > 100 || resultText.includes('\n');

    return (
        <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-mono text-[11px] leading-relaxed">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={bodyId}
                className="w-full px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 font-sans cursor-pointer transition-colors text-left"
            >
                {open ? (
                    <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <Wrench className={`w-3 h-3 shrink-0 ${statusIconClass(tool)}`} aria-hidden="true" />
                <span className="font-semibold text-zinc-300 shrink-0">{tool.name}</span>
                {tool.status === 'executing' && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" aria-label="running" />
                )}
                {tool.status === 'error' && <span className="text-red-400 shrink-0">error</span>}
                {!open && resultText && (
                    <span className="text-zinc-500 truncate">
                        {tool.isError ? '! ' : '→ '}
                        {firstLine}
                        {truncated ? '…' : ''}
                    </span>
                )}
            </button>
            {/* Always rendered, toggled with `hidden`: aria-controls must point at
                an element that EXISTS, or assistive tech resolves it to nothing. */}
            <div id={bodyId} hidden={!open} className="border-t border-white/5 bg-black/20">
                <pre className="p-2.5 m-0 text-zinc-400 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word select-all">
                    {prettyInput}
                </pre>
                {resultText && (
                    <pre
                        className={`p-2.5 m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word select-all border-t border-white/5 ${
                            tool.isError ? 'text-red-300' : 'text-emerald-200/80'
                        }`}
                    >
                        {resultText}
                    </pre>
                )}
            </div>
        </div>
    );
}

/** Edit / Write / MultiEdit / NotebookEdit rendered as a +/- line diff. */
export function DiffToolRow({ tool }: { tool: ToolCallEntry }) {
    const [open, setOpen] = useState(false);
    const bodyId = useId();

    const hunks = extractDiffHunks(tool.name, tool.inputJson);
    if (!hunks) return <PlainToolRow tool={tool} />;

    const rows: DiffRow[] = [];
    let adds = 0;
    let dels = 0;
    for (const hunk of hunks.hunks) {
        for (const row of diffLines(hunk.old, hunk.new)) {
            if (row.type === 'add') adds++;
            else if (row.type === 'del') dels++;
            rows.push(row);
        }
    }
    const shown = rows.slice(0, MAX_DIFF_ROWS);
    const fileName = hunks.file ? hunks.file.split(/[\\/]/).pop() : tool.name;

    return (
        <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-mono text-[11px] leading-relaxed">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={bodyId}
                className="w-full px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400 hover:text-zinc-200 font-sans cursor-pointer transition-colors text-left"
            >
                {open ? (
                    <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <Pencil
                    className={`w-3 h-3 shrink-0 ${tool.isError ? 'text-red-400' : 'text-primary'}`}
                    aria-hidden="true"
                />
                <span className="font-semibold text-zinc-300 truncate">{fileName}</span>
                <span className="text-emerald-400 shrink-0">{`+${adds}`}</span>
                <span className="text-red-400 shrink-0">{`-${dels}`}</span>
                {tool.status === 'executing' && (
                    <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" aria-label="running" />
                )}
            </button>
            {/* The container is always rendered so aria-controls resolves; its
                (unbounded) row children are only built when it is open. */}
            <div
                id={bodyId}
                hidden={!open}
                className="border-t border-white/5 bg-black/20 max-h-64 overflow-auto"
            >
                {open && (
                    <>
                        {hunks.file && (
                            <div className="px-2.5 py-1 text-[10px] text-zinc-500 border-b border-white/5 truncate">
                                {hunks.file}
                            </div>
                        )}
                        {shown.map((row, index) => (
                            <div
                                key={index}
                                className={`px-2.5 whitespace-pre-wrap wrap-break-word ${
                                    row.type === 'add'
                                        ? 'bg-emerald-500/10 text-emerald-300'
                                        : row.type === 'del'
                                          ? 'bg-red-500/10 text-red-300'
                                          : 'text-zinc-500'
                                }`}
                            >
                                <span className="select-none opacity-60">
                                    {row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '}
                                </span>
                                {row.text || ' '}
                            </div>
                        ))}
                        {rows.length > MAX_DIFF_ROWS && (
                            <div className="px-2.5 py-1 text-[10px] text-zinc-600">
                                … {rows.length - MAX_DIFF_ROWS} more lines
                            </div>
                        )}
                        {tool.isError && tool.result && (
                            <pre className="p-2.5 m-0 text-red-300 max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-white/5">
                                {tool.result}
                            </pre>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/** TodoWrite → checklist. Returns null when the input carries no todos. */
export function TodoList({ inputJson }: { inputJson: string }): ReactElement | null {
    const todos = parseTodos(inputJson);
    if (!todos.length) return null;

    const done = todos.filter((todo) => todo?.status === 'completed').length;

    return (
        <div className="bg-black/30 border border-white/10 rounded-lg overflow-hidden font-sans text-[11px]">
            <div className="px-2.5 py-1.5 bg-white/5 flex items-center gap-1.5 text-[10px] text-zinc-400">
                <ListTodo className="w-3 h-3 text-primary shrink-0" aria-hidden="true" />
                <span className="font-semibold text-zinc-300">Tasks</span>
                <span className="text-zinc-500">
                    {done}/{todos.length}
                </span>
            </div>
            <ul className="p-2 flex flex-col gap-1 list-none m-0">
                {todos.map((todo, index) => {
                    const status = todo?.status;
                    return (
                        <li key={index} className="flex items-start gap-1.5">
                            <span
                                className={`mt-0.5 shrink-0 ${
                                    status === 'completed'
                                        ? 'text-emerald-400'
                                        : status === 'in_progress'
                                          ? 'text-primary'
                                          : 'text-zinc-600'
                                }`}
                                aria-hidden="true"
                            >
                                {status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'}
                            </span>
                            <span className={status === 'completed' ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
                                <span className="sr-only">{`${status ?? 'pending'}: `}</span>
                                {todo?.content ?? todo?.title ?? ''}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
