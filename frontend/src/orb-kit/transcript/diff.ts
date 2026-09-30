/**
 * Pure diff / counting helpers for the tool rows.
 *
 * Ported from VST-Foundry-UI/src/components/orb/Transcript.tsx, where they were
 * module-private next to the components. They live in their own file here so
 * they can be tested without a DOM — every rule below (which tools are
 * diffable, how a MultiEdit is unpacked, when the LCS table is abandoned) is a
 * correctness rule, not a rendering detail.
 *
 * No `diff` npm dependency: `diffLines` is the Foundry's own minimal LCS.
 */

import type { ToolCallEntry } from '../stream/types';

/** File-mutating tools whose input can be rendered as a +/- diff. */
const DIFFABLE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function isDiffableTool(name: string): boolean {
    return DIFFABLE_TOOLS.has(name);
}

export interface TodoItem {
    status?: string;
    content?: string;
    title?: string;
}

/**
 * Read the todo list out of a TodoWrite input.
 *
 * This is a decision, not a formatting detail: an empty list means the row must
 * fall back to the plain JSON renderer instead of drawing an empty checklist.
 * (The Foundry tried to express that with `const el = <TodoList/>; if (el)` —
 * which is always truthy, so its fallback never fired.)
 */
export function parseTodos(inputJson: string): TodoItem[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(inputJson);
    } catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];
    const todos = (parsed as { todos?: unknown }).todos;
    return Array.isArray(todos) ? (todos as TodoItem[]) : [];
}

export interface DiffHunks {
    file: string;
    hunks: Array<{ old: string; new: string }>;
}

export type DiffRowType = 'add' | 'del' | 'ctx';

export interface DiffRow {
    type: DiffRowType;
    text: string;
}

/** Total tool count + error count across a tree, sub-agent calls included. */
export function countTools(tools: ToolCallEntry[]): { total: number; errors: number } {
    let total = 0;
    let errors = 0;
    for (const tool of tools) {
        total += 1;
        if (tool.isError) errors += 1;
        if (tool.subCalls?.length) {
            const nested = countTools(tool.subCalls);
            total += nested.total;
            errors += nested.errors;
        }
    }
    return { total, errors };
}

/** Pull the before/after hunks out of a file-mutating tool's input. */
export function extractDiffHunks(name: string, inputJson: string): DiffHunks | null {
    let input: unknown;
    try {
        input = JSON.parse(inputJson);
    } catch {
        return null;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const file = String(record.file_path ?? record.notebook_path ?? record.path ?? '');

    if (name === 'Edit') {
        return { file, hunks: [{ old: String(record.old_string ?? ''), new: String(record.new_string ?? '') }] };
    }
    if (name === 'MultiEdit') {
        const edits = Array.isArray(record.edits) ? record.edits : [];
        return {
            file,
            hunks: edits.map((edit) => {
                const e = (typeof edit === 'object' && edit !== null ? edit : {}) as Record<string, unknown>;
                return { old: String(e.old_string ?? ''), new: String(e.new_string ?? '') };
            }),
        };
    }
    if (name === 'Write') return { file, hunks: [{ old: '', new: String(record.content ?? '') }] };
    if (name === 'NotebookEdit') return { file, hunks: [{ old: '', new: String(record.new_source ?? '') }] };
    return null;
}

/**
 * Minimal LCS line diff. Falls back to del-all/add-all on very large hunks so an
 * oversized Edit cannot blow up the O(m·n) table and freeze the panel.
 */
export function diffLines(oldStr: string, newStr: string): DiffRow[] {
    const a = oldStr.split('\n');
    const b = newStr.split('\n');
    const m = a.length;
    const n = b.length;

    if (oldStr.length + newStr.length > 40000 || m * n > 250000) {
        return [
            ...a.map((text): DiffRow => ({ type: 'del', text })),
            ...b.map((text): DiffRow => ({ type: 'add', text })),
        ];
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const out: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            out.push({ type: 'ctx', text: a[i] });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            out.push({ type: 'del', text: a[i] });
            i++;
        } else {
            out.push({ type: 'add', text: b[j] });
            j++;
        }
    }
    while (i < m) out.push({ type: 'del', text: a[i++] });
    while (j < n) out.push({ type: 'add', text: b[j++] });
    return out;
}
