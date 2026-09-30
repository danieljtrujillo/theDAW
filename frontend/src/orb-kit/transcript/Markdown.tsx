/**
 * Assistant prose renderer.
 *
 * theDAW used to render markdown with react-markdown + remark-gfm into a
 * container carrying `prose prose-invert prose-sm …`. Those classes never did
 * anything: `@tailwindcss/typography` is not a dependency of this frontend (not
 * in package.json, no `@plugin` in the CSS), so every `prose-*` class compiled
 * to nothing while Tailwind's preflight went on flattening headings, lists,
 * table borders and code. Assistant replies came out as undifferentiated text.
 *
 * It now renders the way the Foundry's red orb does: `simpleMarkdown` (a
 * literal copy of its renderer, in ./markdown.ts) produces plain HTML, and
 * ./assistant-prose.css — the Foundry's own prose rules, re-scoped so they need
 * no `.gantasmo-orb-theme` ancestor — formats it.
 *
 * theDAW's two extras survive the swap, both wired by DELEGATION because the
 * markup arrives as a string:
 *   - the hover "Copy code" button on a fenced block, and
 *   - click-to-copy on inline code (`title="Click to copy"`), which the
 *     transcript port had dropped.
 * No handler is ever injected into the HTML; the container's own onClick
 * resolves the target with `closest()`.
 */

import type { MouseEvent } from 'react';

// The extension is REQUIRED. `markdown.ts` and `Markdown.tsx` differ only by
// case, and every resolver here (node, tsx, Vite) tries `.ts` before `.tsx` on
// a case-insensitive filesystem — so a bare `./markdown` or `./Markdown` picks
// whichever file the OS matches first. Do not "tidy" these away.
import { simpleMarkdown } from './markdown.ts';

/*
 * The stylesheet is loaded here, next to the only component that needs it.
 *
 * It is a GUARDED DYNAMIC import rather than a plain `import './…css'` for one
 * concrete reason: this module is in the graph of two tsx test suites
 * (transcript/transcriptRender.test.tsx and orb-kit/AssistantPanel.render.test.ts),
 * and `npx tsx` runs them on node, which rejects a `.css` specifier outright
 * (ERR_UNKNOWN_FILE_EXTENSION). Vite still sees a static specifier and emits
 * the asset; node never evaluates the call because it has no `document`.
 */
if (typeof document !== 'undefined') {
    void import('./assistant-prose.css').catch(() => {});
}

const copyToClipboard = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
};

/** lucide-react's `copy` icon, inlined — the button lives in an HTML string. */
const COPY_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';

const COPY_BUTTON =
    '<button type="button" class="assistant-prose__copy" data-copy-code="" ' +
    'title="Copy code" aria-label="Copy code block">' +
    COPY_ICON +
    '</button>';

/**
 * Add theDAW's copy affordances to `simpleMarkdown`'s output.
 *
 * Both rewrites are safe against injected markup because simpleMarkdown escapes
 * `&`, `<` and `>` in every path: the ONLY literal `<pre>`/`<code>` in its
 * output are the ones it emitted itself. Assistant text containing "<pre>"
 * arrives here as `&lt;pre&gt;` and is untouched.
 *
 * Order matters. Inline code is titled first, while a fenced block is still
 * written `<pre><code` and the lookbehind can exclude it; the `<pre>` wrapper
 * (which must sit OUTSIDE the block, since `pre` scrolls horizontally and would
 * carry an absolutely-positioned button off-screen) goes on afterwards.
 */
export function enrichProseHtml(html: string): string {
    return html
        .replace(/(?<!<pre>)<code>/g, '<code title="Click to copy">')
        .replace(/<pre>/g, `<div class="assistant-prose__block">${COPY_BUTTON}<pre>`)
        .replace(/<\/pre>/g, '</pre></div>');
}

export function Markdown({ text }: { text: string }) {
    const html = enrichProseHtml(simpleMarkdown(text));

    // Delegation. The copy button is checked first because it is a SIBLING of
    // the <pre>, not a descendant of it.
    const onClick = (event: MouseEvent<HTMLDivElement>) => {
        const target = event.target as Element | null;
        if (!target || typeof target.closest !== 'function') return;

        const button = target.closest('[data-copy-code]');
        if (button) {
            copyToClipboard(button.parentElement?.querySelector('pre')?.textContent ?? '');
            return;
        }
        const pre = target.closest('pre');
        if (pre) {
            copyToClipboard(pre.textContent ?? '');
            return;
        }
        const code = target.closest('code');
        if (code) copyToClipboard(code.textContent ?? '');
    };

    return (
        // eslint-disable-next-line react/no-danger -- simpleMarkdown escapes & < >
        // before it builds any HTML and whitelists link schemes; markdown.test.ts
        // pins a <script> tag, an onerror= attribute and a javascript: link inert.
        <div className="assistant-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    );
}
