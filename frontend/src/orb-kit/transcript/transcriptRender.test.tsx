import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Transcript } from './Transcript.tsx';
import { PlainToolRow, DiffToolRow } from './ToolRows.tsx';
import { AgentToolCard } from './ToolCallList.tsx';
import { CollapsibleReasoning } from './CollapsibleReasoning.tsx';
import type { PendingDawAction, ToolCallEntry } from '../stream/types.ts';

/**
 * These render through react-dom/server, so they need no DOM and no new
 * dependency — react-dom is already a runtime dep of the app.
 */

const noop = () => {};

function tool(partial: Partial<ToolCallEntry> & { toolId: string }): ToolCallEntry {
    return { name: 'Read', inputJson: '{"file_path":"a.ts"}', status: 'success', ...partial };
}

/** Every id an aria-controls points at must exist in the same markup. */
function assertAriaControlsResolve(markup: string, label: string) {
    const targets = [...markup.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(targets.length > 0, `${label}: expected at least one aria-controls`);
    for (const id of targets) {
        assert.ok(
            markup.includes(`id="${id}"`),
            `${label}: aria-controls="${id}" points at an element that is not rendered`,
        );
    }
}

// ---------------------------------------------------------------------------
// R1 #6 — a collapsed disclosure must still render its controlled element
// ---------------------------------------------------------------------------

{
    const markup = renderToStaticMarkup(<PlainToolRow tool={tool({ toolId: 't1', result: 'ok' })} />);
    assert.match(markup, /aria-expanded="false"/);
    assertAriaControlsResolve(markup, 'PlainToolRow collapsed');
    assert.match(markup, /hidden=""/, 'the collapsed body is hidden, not absent');
}

{
    const markup = renderToStaticMarkup(
        <DiffToolRow
            tool={tool({
                toolId: 't2',
                name: 'Edit',
                inputJson: JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
            })}
        />,
    );
    assertAriaControlsResolve(markup, 'DiffToolRow collapsed');
    assert.match(markup, /hidden=""/);
}

{
    const markup = renderToStaticMarkup(<CollapsibleReasoning thinking="deep thoughts" />);
    assertAriaControlsResolve(markup, 'CollapsibleReasoning collapsed');
    assert.match(markup, /hidden=""/);
    // Collapsed text must still be in the DOM for the control to point at it.
    assert.match(markup, /deep thoughts/);
}

{
    // AgentToolCard defaults OPEN, so its body must be present and NOT hidden.
    const markup = renderToStaticMarkup(
        <AgentToolCard
            tool={tool({
                toolId: 'task1',
                name: 'Task',
                inputJson: JSON.stringify({ subagent_type: 'scout', description: 'look around' }),
                subCalls: [tool({ toolId: 's1' })],
            })}
        />,
    );
    assert.match(markup, /aria-expanded="true"/);
    assertAriaControlsResolve(markup, 'AgentToolCard open');
}

// ---------------------------------------------------------------------------
// R1 #1 — parked T2 actions render DURING the live turn, and are not disabled
// ---------------------------------------------------------------------------

const parked: PendingDawAction = {
    type: 'generate',
    payload: { prompt: 'drums' },
    callId: 'c9',
    description: 'Start audio generation (spends GPU time)',
    sessionId: 'relay-1',
};

function transcript(props: Partial<React.ComponentProps<typeof Transcript>> = {}) {
    return renderToStaticMarkup(
        <Transcript
            messages={[]}
            isStreaming={true}
            liveText=""
            liveThinking=""
            liveToolCalls={[]}
            livePendingActions={[]}
            pendingControls={[]}
            onCopyMessage={noop}
            onRetry={noop}
            onAnswerControl={noop}
            onRunPendingAction={noop}
            onSkipPendingAction={noop}
            {...props}
        />,
    );
}

{
    const markup = transcript({ livePendingActions: [parked] });
    assert.match(markup, /Run ?generate|aria-label="Run generate"/, 'the live Run button is rendered mid-turn');
    assert.match(markup, /aria-label="Skip generate"/);
    assert.match(markup, /Start audio generation/);
    assert.doesNotMatch(
        markup,
        /disabled=""/,
        'the whole point is that a mid-turn action is answerable while streaming',
    );
}

// A message-bound action is likewise answerable while a later turn streams.
{
    const markup = transcript({
        isStreaming: true,
        messages: [{ id: 'm1', role: 'assistant', text: '', pendingActions: [parked], timestamp: 0 }],
    });
    assert.match(markup, /aria-label="Run generate"/);
    assert.doesNotMatch(markup, /disabled=""/);
}

// ---------------------------------------------------------------------------
// The empty-bubble fix, proven in markup
// ---------------------------------------------------------------------------

{
    const markup = transcript({
        isStreaming: false,
        messages: [
            { id: 'm1', role: 'assistant', text: '', toolCalls: [tool({ toolId: 't1' })], timestamp: 0 },
        ],
    });
    assert.doesNotMatch(markup, /aria-label="Copy message"/, 'a tool-only turn has no Copy');
    assert.doesNotMatch(markup, /aria-label="Retry this turn"/);
}

{
    const markup = transcript({
        isStreaming: false,
        messages: [{ id: 'm1', role: 'assistant', text: 'here you go', timestamp: 0 }],
    });
    assert.match(markup, /aria-label="Copy message"/);
    assert.match(markup, /aria-label="Retry this turn"/);
}

// ---------------------------------------------------------------------------
// T2 — the bubble formats prose the way the Foundry's orb does
//
// The old renderer hung `prose prose-invert prose-sm …` on the container, and
// `@tailwindcss/typography` is not installed here, so every one of those
// classes compiled to nothing while preflight flattened the markup underneath.
// These assertions are about the markup that replaced it.
// ---------------------------------------------------------------------------

const RICH = [
    '# Heading',
    '',
    '- one',
    '- two',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'call `npm test` first',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '> quoted',
    '',
    '---',
    '',
    '[docs](https://example.com)',
].join('\n');

{
    const markup = transcript({
        isStreaming: false,
        messages: [{ id: 'm1', role: 'assistant', text: RICH, timestamp: 0 }],
    });

    // The prose container the stylesheet targets. No `prose-*` no-ops left.
    assert.match(markup, /class="assistant-prose"/);
    assert.doesNotMatch(markup, /prose-invert/, 'the typography-plugin classes are gone');

    // Every block the ticket names comes out as a real element.
    assert.match(markup, /<h1>Heading<\/h1>/);
    assert.match(markup, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(markup, /<table><thead><tr><th>a<\/th>/);
    assert.match(markup, /<blockquote>quoted<\/blockquote>/);
    assert.match(markup, /<hr\/>/);
    assert.match(markup, /<pre><code class="language-ts">/);
    assert.match(markup, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">docs<\/a>/);

    // theDAW's two extras on top of the copy.
    assert.match(markup, /aria-label="Copy code block"/, 'the hover Copy-code button survives the swap');
    assert.match(markup, /<code title="Click to copy">npm test<\/code>/, 'inline click-to-copy is restored');
}

// The HTML is injected, so the render layer gets its own inertness check.
{
    const markup = transcript({
        isStreaming: false,
        messages: [
            {
                id: 'm1',
                role: 'assistant',
                text: '<script>alert(1)</script> and [x](javascript:alert(1))',
                timestamp: 0,
            },
        ],
    });
    assert.doesNotMatch(markup, /<script/i);
    assert.doesNotMatch(markup, /javascript:/i);
    assert.match(markup, /href="#"/);
}

// Bubble structure: the speaker column's caption, and pre-line user text.
{
    const markup = transcript({
        isStreaming: false,
        messages: [
            { id: 'm1', role: 'user', text: 'line one\nline two', timestamp: 0 },
            { id: 'm2', role: 'assistant', text: 'ok', timestamp: 0 },
        ],
    });
    assert.match(markup, /GANTASMO/, 'the assistant avatar carries the Foundry caption');
    assert.match(markup, /whitespace-pre-line/, 'user text keeps its line breaks');
    // Foundry bubble metrics: 12px radius with a 4px tail on the speaker's side.
    assert.match(markup, /rounded-xl rounded-br-sm/, 'user bubble tails bottom-right');
    assert.match(markup, /rounded-xl rounded-bl-sm/, 'assistant bubble tails bottom-left');
    assert.match(markup, /max-w-\[85%\]/);
}

// The live row carries the Foundry's blinking caret, not a Tailwind pulse bar.
{
    const markup = transcript({ isStreaming: true, liveText: 'thinking out loud' });
    assert.match(markup, /class="assistant-prose__cursor"/);
    assert.doesNotMatch(markup, /animate-pulse/);
}

console.log('transcript render regression passed');
