/**
 * `simpleMarkdown` — the renderer that replaced react-markdown in the assistant
 * bubble.
 *
 * Two things are pinned here. FORMATTING: every block the assistant actually
 * emits must come out as a real element, because the whole point of the swap is
 * that headings, lists, tables and code stopped being visible when the
 * `prose-*` classes turned out to be no-ops. SAFETY: the output is fed to
 * dangerouslySetInnerHTML, so a `<script>` tag, an `onerror=` attribute and a
 * `javascript:` link in assistant text must all come out inert.
 *
 *   cd frontend && npx tsx src/orb-kit/transcript/markdown.test.ts
 */

import assert from 'node:assert/strict';

import { inlineMd, simpleMarkdown } from './markdown.ts';
import { enrichProseHtml } from './Markdown.tsx';

// ---------------------------------------------------------------------------
// Headings h1–h4
// ---------------------------------------------------------------------------

assert.equal(simpleMarkdown('# Title'), '<h1>Title</h1>');
assert.equal(simpleMarkdown('## Title'), '<h2>Title</h2>');
assert.equal(simpleMarkdown('### Title'), '<h3>Title</h3>');
assert.equal(simpleMarkdown('#### Title'), '<h4>Title</h4>');
// Five hashes is not a heading level the renderer knows — it stays prose.
assert.equal(simpleMarkdown('##### Title'), '<p>##### Title</p>');
// Inline markup inside a heading still resolves.
assert.equal(simpleMarkdown('## A **bold** head'), '<h2>A <strong>bold</strong> head</h2>');

// ---------------------------------------------------------------------------
// Inline: strong / em / del / inline code
// ---------------------------------------------------------------------------

assert.equal(inlineMd('**bold**'), '<strong>bold</strong>');
assert.equal(inlineMd('*italic*'), '<em>italic</em>');
assert.equal(inlineMd('~~gone~~'), '<del>gone</del>');
assert.equal(inlineMd('use `npm test`'), 'use <code>npm test</code>');

// ---------------------------------------------------------------------------
// Lists — the bullets/numbers preflight had been eating
// ---------------------------------------------------------------------------

assert.equal(simpleMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
assert.equal(simpleMarkdown('* one\n+ two'), '<ul><li>one</li><li>two</li></ul>');
assert.equal(simpleMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
assert.equal(simpleMarkdown('1) one\n2) two'), '<ol><li>one</li><li>two</li></ol>');
// A list interrupts a paragraph instead of being swallowed by it.
assert.equal(simpleMarkdown('intro\n- one'), '<p>intro</p>\n<ul><li>one</li></ul>');

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

{
    const html = simpleMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    assert.equal(
        html,
        '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
    // The separator row is never emitted as a body row.
    assert.equal((html.match(/<tr>/g) ?? []).length, 2);
}

// ---------------------------------------------------------------------------
// Fenced code, with and without a language
// ---------------------------------------------------------------------------

assert.equal(
    simpleMarkdown('```ts\nconst a = 1;\n```'),
    '<pre><code class="language-ts">const a = 1;\n</code></pre>',
);
assert.equal(simpleMarkdown('```\nplain\n```'), '<pre><code>plain\n</code></pre>');
// Markdown inside a fence stays literal — no <strong>, no <ul>.
{
    const html = simpleMarkdown('```\n**not bold**\n- not a list\n```');
    assert.doesNotMatch(html, /<strong>/);
    assert.doesNotMatch(html, /<ul>/);
    assert.match(html, /\*\*not bold\*\*/);
}
// A fence surrounded by prose keeps its place in the document order.
{
    const html = simpleMarkdown('before\n\n```sh\nls\n```\n\nafter');
    assert.match(html, /<p>before<\/p>[\s\S]*<pre><code class="language-sh">ls\n<\/code><\/pre>[\s\S]*<p>after<\/p>/);
}

// ---------------------------------------------------------------------------
// Blockquote and horizontal rule
// ---------------------------------------------------------------------------

assert.equal(simpleMarkdown('> quoted'), '<blockquote>quoted</blockquote>');
assert.equal(simpleMarkdown('> one\n> two'), '<blockquote>one<br/>two</blockquote>');
for (const rule of ['---', '***', '___', '-----']) {
    assert.equal(simpleMarkdown(rule), '<hr/>', `${rule} is a rule`);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

assert.equal(
    inlineMd('[docs](https://example.com/a)'),
    '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>',
);
for (const url of ['http://example.com', 'mailto:a@b.c', '#anchor', '/local/path']) {
    assert.match(inlineMd(`[x](${url})`), new RegExp(`href="${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
}

// ---------------------------------------------------------------------------
// SAFETY — this output goes straight into dangerouslySetInnerHTML
// ---------------------------------------------------------------------------

// 1. A <script> tag is escaped, never emitted as an element.
{
    const html = simpleMarkdown('<script>alert(1)</script>');
    assert.doesNotMatch(html, /<script/i, 'no live <script> element');
    assert.match(html, /&lt;script&gt;/, 'it survives as visible text');
    // Even inside a fence, where the escaping runs on a different path.
    const fenced = simpleMarkdown('```html\n<script>alert(1)</script>\n```');
    assert.doesNotMatch(fenced, /<script/i);
    assert.match(fenced, /&lt;script&gt;/);
    // And inside a table cell, a heading and a list item.
    assert.doesNotMatch(simpleMarkdown('| <script>x</script> |'), /<script/i);
    assert.doesNotMatch(simpleMarkdown('# <script>x</script>'), /<script/i);
    assert.doesNotMatch(simpleMarkdown('- <script>x</script>'), /<script/i);
}

// 2. An event-handler attribute cannot be attached to anything: the tag that
//    would carry it is escaped whole, so `onerror=` lands in a text node.
{
    const html = simpleMarkdown('<img src=x onerror="alert(1)">');
    assert.doesNotMatch(html, /<img/i, 'no live <img> element');
    assert.equal(html, '<p>&lt;img src=x onerror="alert(1)"&gt;</p>', 'the whole tag is text');
    // The same through a link label, which is interpolated straight into markup.
    const labelled = inlineMd('[<img src=x onerror=alert(1)>](https://example.com)');
    assert.doesNotMatch(labelled, /<img/i);
    assert.match(labelled, /&gt;<\/a>$/, 'the label is escaped before it is placed inside the <a>');
}

// 3. A javascript: (or data:) link collapses to "#".
{
    assert.match(inlineMd('[click](javascript:alert(1))'), /href="#"/);
    assert.doesNotMatch(inlineMd('[click](javascript:alert(1))'), /javascript:/i);
    assert.match(inlineMd('[click](JaVaScRiPt:alert(1))'), /href="#"/);
    assert.match(inlineMd('[click](data:text/html,<script>alert(1)</script>)'), /href="#"/);
    assert.match(inlineMd('[click](vbscript:msgbox)'), /href="#"/);
    // A quote in an allowed URL cannot break out of the href attribute.
    const broken = inlineMd('[click](https://e.com/" onmouseover="alert(1))');
    assert.doesNotMatch(broken, /onmouseover="/, 'the quote is percent-encoded, so no new attribute appears');
    assert.match(broken, /%22/);
}

// ---------------------------------------------------------------------------
// enrichProseHtml — theDAW's copy affordances, added to the string output
// ---------------------------------------------------------------------------

{
    const html = enrichProseHtml(simpleMarkdown('```ts\nconst a = 1;\n```'));
    assert.match(html, /<div class="assistant-prose__block">/);
    assert.match(html, /aria-label="Copy code block"/);
    assert.match(html, /data-copy-code=""/);
    // The button is a SIBLING of <pre>, not a child: <pre> scrolls.
    assert.match(html, /<\/button><pre>/);
    assert.match(html, /<\/pre><\/div>/);
    // A fenced block's <code> must NOT get the inline click-to-copy title.
    assert.doesNotMatch(html, /<code class="language-ts" title=/);
}

{
    const html = enrichProseHtml(simpleMarkdown('run `npm test` now'));
    assert.match(html, /<code title="Click to copy">npm test<\/code>/);
    assert.doesNotMatch(html, /assistant-prose__block/, 'inline code is not a block');
}

{
    // A fence with no language emits `<pre><code>` — the lookbehind must leave
    // that <code> alone while still titling inline code in the same document.
    const html = enrichProseHtml(simpleMarkdown('use `x`\n\n```\nplain\n```'));
    assert.match(html, /<code title="Click to copy">x<\/code>/);
    assert.match(html, /<pre><code>plain/, 'the fenced <code> keeps no title');
    assert.equal((html.match(/title="Click to copy"/g) ?? []).length, 1);
}

{
    // "<pre>" written by the ASSISTANT is escaped text, so the wrapper rewrite
    // cannot be tricked into producing an extra button or an unbalanced div.
    const html = enrichProseHtml(simpleMarkdown('write <pre> and </pre> please'));
    assert.doesNotMatch(html, /assistant-prose__block/);
    assert.match(html, /&lt;pre&gt;/);
}

console.log('markdown: all assertions passed');
