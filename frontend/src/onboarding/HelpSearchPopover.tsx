/**
 * The header's "?" — ask where something is, and be taken to it.
 *
 * The shell used to offer one help affordance: a Docs button onto a 185KB
 * manual whose only search filters headings by substring. That answers
 * "where is the library?" only for someone who already knows the heading is
 * called Library. This searches the feature registry instead — the same data
 * the tour and the pinned notes read, so it cannot drift from them — and every
 * hit says what the thing is, how to use it, and which tab it lives in.
 *
 * The part a document search cannot do is the last button on each card. A
 * registry hit carries a selector, so LOCATE hands the id to the solo
 * spotlight: the app switches workspace, opens the panel the control lives in,
 * and rings the real control on the real screen. Nothing is closed again
 * afterwards — you asked to be taken there.
 *
 * Docs did not go away; it sits beside the input, one click further in, and
 * still opens the manual untouched.
 *
 * Keyboard: the field takes focus on open, ↓ steps into the results, ↑ comes
 * back out of the top of them, Enter locates the best hit, and Esc closes and
 * hands focus back to the "?" button.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, HelpCircle, ScanSearch, Search } from 'lucide-react';
import { TopBarButton } from '../components/layout/TopBarButton';
import { useOnboardingStore } from './onboardingStore';
import { type FeatureEntry } from './featureRegistry';
import { featuredFeatures, searchFeatures } from './featureSearch';

const PANEL_ID = 'help-search-panel';
const INPUT_ID = 'help-search-query';
const RESULTS_ID = 'help-search-results';
/** Enough room for a handful of answers; more than that and nobody reads them. */
const RESULT_LIMIT = 5;

interface HelpSearchPopoverProps {
  /** Open the full manual. Unchanged behaviour — the modal is not deep-linked. */
  onOpenDocs: () => void;
}

export const HelpSearchPopover: React.FC<HelpSearchPopoverProps> = ({ onOpenDocs }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const typed = query.trim().length > 0;
  const results = useMemo(
    () => (typed ? searchFeatures(query, RESULT_LIMIT).map((h) => h.feature) : featuredFeatures()),
    [query, typed],
  );

  /** Close, and say whether focus should come back to the trigger. */
  const close = (restoreFocus: boolean) => {
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    setQuery('');
  };

  // Clicking anywhere else closes it, and deliberately does NOT pull focus
  // back — the click has already put focus where the user wanted it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Land in the field: the popover exists to be typed into.
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const locateButtons = (): HTMLButtonElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-help-locate]') ?? []);

  const locate = (feature: FeatureEntry) => {
    // Focus goes back to the trigger BEFORE the panel unmounts: the spotlight
    // remembers whatever is focused as it opens and returns focus there when it
    // closes, so this is what puts the user back on the "?" afterwards.
    close(true);
    useOnboardingStore.getState().spotlightOne(feature.id);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      locateButtons()[0]?.focus();
    } else if (e.key === 'Enter' && typed) {
      // Only once something has been asked. Enter on an empty field would
      // otherwise jump to whichever entry happens to head the starting list.
      e.preventDefault();
      const best = results.find((f) => f.locate);
      if (best) locate(best);
    }
  };

  // Arrows walk the results; ↑ off the top goes back to the field, so there is
  // always a way out that is not Tab.
  const onResultsKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = locateButtons();
    if (!items.length) return;
    const here = items.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    if (e.key === 'ArrowDown') {
      items[Math.min(items.length - 1, here + 1)]?.focus();
    } else if (here <= 0) {
      inputRef.current?.focus();
    } else {
      items[here - 1]?.focus();
    }
  };

  return (
    // The hook sits on the wrapper rather than the button because TopBarButton
    // takes no data attributes; the panel is absolutely positioned, so the
    // wrapper's box is exactly the trigger's and a spotlight rings the button.
    <div data-tour="help" className="relative" ref={rootRef}>
      <TopBarButton
        buttonRef={triggerRef}
        onClick={() => (open ? close(true) : setOpen(true))}
        icon={<HelpCircle className="w-3.5 h-3.5" />}
        title="Find a feature, or open the docs"
        accent="purple"
        active={open}
        ariaHasPopup="dialog"
        ariaExpanded={open}
        ariaControls={open ? PANEL_ID : undefined}
      />

      {open && (
        <div
          id={PANEL_ID}
          role="dialog"
          aria-label="Find a feature"
          // Esc is caught for the whole panel rather than per control, so it
          // works from the field, the Docs button and every result alike.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close(true);
          }}
          className="absolute right-0 top-full mt-1 z-50 w-96 max-w-[92vw] flex flex-col gap-2 rounded-lg border border-purple-500/30 bg-[#0a080f] p-2 shadow-[0_8px_32px_rgba(0,0,0,0.75)]"
        >
          <div className="flex items-center gap-1.5">
            <label htmlFor={INPUT_ID} className="sr-only">
              Find a feature
            </label>
            <div className="relative flex-1 min-w-0">
              <Search
                aria-hidden="true"
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600"
              />
              <input
                ref={inputRef}
                id={INPUT_ID}
                name={INPUT_ID}
                type="search"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="WHERE IS…?"
                className="compact-input w-full pl-7"
              />
            </div>
            <TopBarButton
              onClick={() => {
                close(false);
                onOpenDocs();
              }}
              icon={<BookOpen className="w-3.5 h-3.5" />}
              title="Open the full documentation"
              accent="purple"
            />
          </div>

          <p className="sr-only" aria-live="polite">
            {typed ? `${results.length} matching features` : ''}
          </p>

          {!typed && (
            <p className="px-0.5 text-[8px] font-mono uppercase tracking-widest text-zinc-600">
              Start here
            </p>
          )}

          {typed && results.length === 0 ? (
            <p className="px-0.5 py-2 text-[10px] leading-relaxed text-zinc-500">
              Nothing here is called “{query.trim()}”. Try a tab or panel name — or open the
              docs with the button above.
            </p>
          ) : (
            <ul
              id={RESULTS_ID}
              ref={listRef}
              onKeyDown={onResultsKeyDown}
              className="flex flex-col gap-1 max-h-72 overflow-y-auto"
            >
              {results.map((f) => (
                <li
                  key={f.id}
                  className="flex items-start gap-2 rounded border border-white/10 bg-white/3 p-2"
                >
                  <div className="min-w-0 flex-1 flex flex-col gap-1">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="truncate text-[11px] font-black uppercase tracking-widest text-purple-100">
                        {f.name}
                      </span>
                      <span className="shrink-0 text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                        {f.where}
                      </span>
                    </div>
                    <p className="text-[10px] leading-relaxed text-zinc-300">{f.what}</p>
                    <ol className="list-decimal pl-3.5 text-[9px] leading-relaxed text-zinc-500">
                      {f.how.map((stepText) => (
                        <li key={stepText}>{stepText}</li>
                      ))}
                    </ol>
                  </div>
                  {f.locate && (
                    <button
                      type="button"
                      data-help-locate=""
                      onClick={() => locate(f)}
                      title={`Show me where ${f.name} is`}
                      aria-label={`Show me where ${f.name} is`}
                      className="shrink-0 rounded border border-purple-500/30 p-1 text-purple-300 transition-colors hover:bg-purple-500/15 hover:text-purple-200 outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
                    >
                      <ScanSearch className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
