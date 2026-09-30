import assert from 'node:assert/strict';

import { countTools, extractDiffHunks, diffLines, isDiffableTool, parseTodos } from './diff.ts';
import { shouldShowMessageActions, scaleClassFor, toolScaleClassFor, controlSecondsLeft } from './display.ts';
import type { ToolCallEntry } from '../stream/types.ts';

function tool(partial: Partial<ToolCallEntry> & { toolId: string }): ToolCallEntry {
    return { name: 'Read', inputJson: '{}', status: 'success', ...partial };
}

// ---------------------------------------------------------------------------
// countTools — counts the whole tree, sub-agent calls included
// ---------------------------------------------------------------------------

assert.deepEqual(countTools([]), { total: 0, errors: 0 });

assert.deepEqual(
    countTools([
        tool({ toolId: 'a' }),
        tool({ toolId: 'b', isError: true, status: 'error' }),
    ]),
    { total: 2, errors: 1 },
);

assert.deepEqual(
    countTools([
        tool({
            toolId: 'task',
            name: 'Task',
            subCalls: [
                tool({ toolId: 's1' }),
                tool({ toolId: 's2', isError: true, status: 'error' }),
                tool({ toolId: 's3', subCalls: [tool({ toolId: 's3a' })] }),
            ],
        }),
    ]),
    { total: 5, errors: 1 },
);

// ---------------------------------------------------------------------------
// extractDiffHunks
// ---------------------------------------------------------------------------

assert.deepEqual(
    extractDiffHunks('Edit', JSON.stringify({ file_path: 'C:\\a\\b.ts', old_string: 'one', new_string: 'two' })),
    { file: 'C:\\a\\b.ts', hunks: [{ old: 'one', new: 'two' }] },
);

assert.deepEqual(
    extractDiffHunks(
        'MultiEdit',
        JSON.stringify({
            file_path: 'x.ts',
            edits: [
                { old_string: 'a', new_string: 'b' },
                { old_string: 'c', new_string: 'd' },
            ],
        }),
    ),
    { file: 'x.ts', hunks: [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }] },
);

assert.deepEqual(
    extractDiffHunks('Write', JSON.stringify({ file_path: 'new.ts', content: 'hello' })),
    { file: 'new.ts', hunks: [{ old: '', new: 'hello' }] },
);

assert.deepEqual(
    extractDiffHunks('NotebookEdit', JSON.stringify({ notebook_path: 'n.ipynb', new_source: 'cell' })),
    { file: 'n.ipynb', hunks: [{ old: '', new: 'cell' }] },
);

// Non-diffable tool, malformed JSON and non-object input all decline politely.
assert.equal(extractDiffHunks('Bash', JSON.stringify({ command: 'ls' })), null);
assert.equal(extractDiffHunks('Edit', '{not json'), null);
assert.equal(extractDiffHunks('Edit', '"a string"'), null);
// A partial input delta that has not accumulated a file path yet still renders.
assert.deepEqual(extractDiffHunks('Edit', '{}'), { file: '', hunks: [{ old: '', new: '' }] });

assert.equal(isDiffableTool('Edit'), true);
assert.equal(isDiffableTool('MultiEdit'), true);
assert.equal(isDiffableTool('Write'), true);
assert.equal(isDiffableTool('NotebookEdit'), true);
assert.equal(isDiffableTool('Bash'), false);

// ---------------------------------------------------------------------------
// diffLines
// ---------------------------------------------------------------------------

assert.deepEqual(diffLines('a\nb\nc', 'a\nB\nc'), [
    { type: 'ctx', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'add', text: 'B' },
    { type: 'ctx', text: 'c' },
]);

assert.deepEqual(diffLines('', 'only'), [
    { type: 'del', text: '' },
    { type: 'add', text: 'only' },
]);

assert.deepEqual(diffLines('same', 'same'), [{ type: 'ctx', text: 'same' }]);

// Pure insertion keeps the shared lines as context instead of rewriting them.
{
    const rows = diffLines('a\nc', 'a\nb\nc');
    assert.deepEqual(rows, [
        { type: 'ctx', text: 'a' },
        { type: 'add', text: 'b' },
        { type: 'ctx', text: 'c' },
    ]);
}

// Oversized hunks bail out of the O(m·n) table into del-all/add-all.
{
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const rows = diffLines(big, big);
    assert.equal(rows.length, 1800);
    assert.equal(rows[0].type, 'del');
    assert.equal(rows[rows.length - 1].type, 'add');
}

// ---------------------------------------------------------------------------
// parseTodos — decides whether a TodoWrite gets a checklist or a plain JSON row
// ---------------------------------------------------------------------------

assert.deepEqual(
    parseTodos(JSON.stringify({ todos: [{ content: 'ship it', status: 'in_progress' }] })),
    [{ content: 'ship it', status: 'in_progress' }],
);
assert.deepEqual(parseTodos('{"todos":[]}'), []);
assert.deepEqual(parseTodos('{}'), [], 'a partial input delta has no todos yet');
assert.deepEqual(parseTodos('{not json'), []);
assert.deepEqual(parseTodos('{"todos":"nope"}'), [], 'a non-array todos field is not a checklist');

// ---------------------------------------------------------------------------
// shouldShowMessageActions — the empty-bubble fix
// ---------------------------------------------------------------------------

const base = { id: 'm', role: 'assistant' as const, text: '', timestamp: 0 };

assert.equal(shouldShowMessageActions({ ...base, text: 'hello' }), true);
assert.equal(shouldShowMessageActions({ ...base, text: '' }), false, 'a tool-only turn has nothing to copy or retry');
assert.equal(shouldShowMessageActions({ ...base, text: '   \n ' }), false);
assert.equal(
    shouldShowMessageActions({ ...base, text: '', toolCalls: [tool({ toolId: 'a' })] }),
    false,
    'tool rows alone must not resurrect Copy/Retry',
);
assert.equal(shouldShowMessageActions({ ...base, role: 'user', text: 'hi' }), false);

// ---------------------------------------------------------------------------
// scale classes
// ---------------------------------------------------------------------------

assert.equal(scaleClassFor('xs'), 'text-[11px] leading-relaxed');
assert.equal(scaleClassFor('md'), 'text-sm leading-relaxed');
assert.equal(scaleClassFor('lg'), 'text-base leading-relaxed');
assert.equal(scaleClassFor('sm'), 'text-[12.5px] leading-relaxed');
assert.equal(toolScaleClassFor('xs'), 'text-[10px]');
assert.equal(toolScaleClassFor('md'), 'text-xs');

// ---------------------------------------------------------------------------
// control countdown — display only; the backend owns the actual auto-deny
// ---------------------------------------------------------------------------

assert.equal(controlSecondsLeft(1000, 1000), 180);
assert.equal(controlSecondsLeft(1000, 31_000), 150);
assert.equal(controlSecondsLeft(1000, 999_000), 0, 'never counts below zero');

console.log('transcript helper regression passed');
