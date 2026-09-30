/**
 * The context meter's data: the CLI's real reading, and the estimate it falls
 * back to.
 *
 * Ported from the Foundry orb (`refreshContextUsage` in
 * `src/components/orb/useChatStream.ts` + `getContextPercentage` in
 * AIAssistantOrb.tsx). The reading comes from a child process that may be busy,
 * gone, or answering something else entirely, so EVERY unhappy shape has to
 * resolve to `null` — the meter falls back to the estimate, it never throws
 * inside a render or an effect.
 *
 *   cd frontend && npx tsx src/orb-kit/contextUsage.test.ts
 */
import assert from 'node:assert/strict';

const { contextPercentage, fetchContextUsage } = await import('./contextUsage.ts');

/** A `fetch` that answers with one canned body, and records what it was asked. */
const stubFetch = (body: unknown, init: { status?: number; json?: () => unknown } = {}) => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl = (async (url: unknown, requestInit?: RequestInit) => {
        calls.push({ url: String(url), init: requestInit });
        const status = init.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: init.json ?? (async () => body),
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
};

// ---------------------------------------------------------------------------
// fetchContextUsage — the happy path and the contract it posts against
// ---------------------------------------------------------------------------

{
    const { impl, calls } = stubFetch({
        ok: true,
        usage: { totalTokens: 42_000, maxTokens: 200_000, percentage: 21 },
    });
    const usage = await fetchContextUsage('conv-1', impl);
    assert.deepEqual(usage, { totalTokens: 42_000, maxTokens: 200_000, percentage: 21 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/assistant/context-usage');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { conversationId: 'conv-1' });
}

// snake_case is what the CLI itself emits; the backend may pass either spelling
// straight through, so both are read (the Foundry reads both too).
{
    const { impl } = stubFetch({
        ok: true,
        usage: { total_tokens: 10, max_tokens: 100, percentage: 10 },
    });
    assert.deepEqual(await fetchContextUsage('conv-1', impl), {
        totalTokens: 10,
        maxTokens: 100,
        percentage: 10,
    });
}

// Without a conversation there is nothing to ask about — and no request to make.
{
    const { impl, calls } = stubFetch({ ok: true, usage: { totalTokens: 1, maxTokens: 2, percentage: 3 } });
    assert.equal(await fetchContextUsage(null, impl), null);
    assert.equal(await fetchContextUsage('', impl), null);
    assert.equal(await fetchContextUsage(undefined, impl), null);
    assert.equal(calls.length, 0, 'no conversation id means no request at all');
}

// ---------------------------------------------------------------------------
// fetchContextUsage — every failure shape is `null`, never a throw
// ---------------------------------------------------------------------------

{
    // 504: the contract's "the CLI did not answer".
    const { impl } = stubFetch({ ok: false, error: 'timeout' }, { status: 504 });
    assert.equal(await fetchContextUsage('conv-1', impl), null, 'a non-200 is not a reading');
}
{
    const { impl } = stubFetch({ ok: false, error: 'unknown conversation' }, { status: 404 });
    assert.equal(await fetchContextUsage('conv-1', impl), null);
}
{
    // 200 with ok:false — the backend answered, the CLI did not.
    const { impl } = stubFetch({ ok: false, error: 'no answer' });
    assert.equal(await fetchContextUsage('conv-1', impl), null, 'ok:false is not a reading');
}
for (const malformed of [
    null,
    undefined,
    'not json at all',
    { ok: true },
    { ok: true, usage: null },
    { ok: true, usage: {} },
    { ok: true, usage: { totalTokens: 1, maxTokens: 2 } },
    { ok: true, usage: { totalTokens: 1, maxTokens: 2, percentage: 'lots' } },
    { ok: true, usage: { totalTokens: 1, maxTokens: 2, percentage: Number.NaN } },
]) {
    const { impl } = stubFetch(malformed);
    assert.equal(
        await fetchContextUsage('conv-1', impl),
        null,
        `a body without a usable percentage is not a reading: ${JSON.stringify(malformed)}`,
    );
}
{
    // A body that is not JSON at all: `json()` rejects.
    const { impl } = stubFetch(undefined, {
        json: () => {
            throw new SyntaxError('Unexpected token < in JSON');
        },
    });
    assert.equal(await fetchContextUsage('conv-1', impl), null);
}
{
    // The network itself failed (backend down mid-turn).
    const impl = (async () => {
        throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    assert.equal(await fetchContextUsage('conv-1', impl), null, 'a thrown fetch never escapes');
}

// Tokens that are missing or unparseable still give a usable reading — the
// percentage is the part the meter draws; the token counts only fill the title.
{
    const { impl } = stubFetch({ ok: true, usage: { percentage: 12 } });
    assert.deepEqual(await fetchContextUsage('conv-1', impl), {
        totalTokens: 0,
        maxTokens: 0,
        percentage: 12,
    });
}

// ---------------------------------------------------------------------------
// contextPercentage — the real reading wins, the estimate is the fallback
// ---------------------------------------------------------------------------

const msg = (text: string, thinking?: string) => ({ text, thinking });

// A real reading is used as-is (0-100), rounded and clamped.
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 42 }, []), 42);
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 42.4 }, []), 42);
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 42.6 }, []), 43);
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 180 }, []), 100, 'clamped high');
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: -5 }, []), 0, 'clamped low');

// A 0-1 fraction is accepted defensively — the CLI has sent both.
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 0.25 }, []), 25);
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 1 }, []), 100);
assert.equal(contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: 0 }, []), 0);

// A reading whose percentage is not a number is no reading at all: estimate.
assert.equal(
    contextPercentage({ totalTokens: 1, maxTokens: 2, percentage: Number.NaN }, [msg('x'.repeat(75_000))]),
    50,
);

// The estimate: total characters of text + thinking over 150k.
assert.equal(contextPercentage(null, []), 0);
assert.equal(contextPercentage(null, [msg('x'.repeat(150_000))]), 100);
assert.equal(contextPercentage(null, [msg('x'.repeat(75_000))]), 50);
assert.equal(contextPercentage(null, [msg('x'.repeat(15_000))]), 10);
assert.equal(
    contextPercentage(null, [msg('x'.repeat(10_000), 'y'.repeat(5_000))]),
    10,
    'reasoning counts against the window too',
);
assert.equal(
    contextPercentage(null, [msg('x'.repeat(7_500)), msg('y'.repeat(7_500))]),
    10,
    'every message in the transcript counts',
);
assert.equal(contextPercentage(null, [msg('x'.repeat(300_000))]), 100, 'the estimate is clamped');
assert.equal(contextPercentage(null, [msg('x'.repeat(1_499))]), 0, 'the estimate floors');
// A row with no text at all (a tools-only turn) is not a crash.
assert.equal(contextPercentage(null, [{ text: '' }, {} as { text?: string }]), 0);

console.log('contextUsage: all assertions passed');
