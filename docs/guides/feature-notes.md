# Feature Notes

Feature Notes are small labels pinned beside the few controls in theDAW that
carry no label of their own. Each one is a card with the name of the thing, one
line saying what it is and how to open it, a pointer at the control itself, and
a close button.

They exist because of a real report: someone spent a long time hunting for the
Library, read the docs and asked the assistant, and only found it by eventually
noticing the slim tab on the right edge of the window.

Two things came out of that, and neither of them is a note. The rail tab now
carries the **LIBRARY** wordmark, so the control says what it is. And the
header's **?** button searches the feature registry and will take you to
anything it names, so "where is X?" has a direct answer at last.

Feature Notes are what is left over: a pinned label beside the few controls that
still carry none. The feature tour did not save that user and structurally
cannot — a tour is a sequence you click through once and then it is gone, so it
teaches nothing about an affordance you next meet three sessions later. A note
stays pinned to the thing until you have actually used it.

## The two notes

| Note | Points at |
|---|---|
| **Log** | The LOG strip at the bottom right — machine stats and every job the app has run. |
| **Panels** | The bottom strip that opens the panel tabs: Score, Sing, Lyric, Levels, MIDI and the rest. |

The Library used to head this list and no longer qualifies: its edge tab carries
the LIBRARY wordmark now, and the first rule is that a control which says what
it is does not get a note. (`featureRegistry.test.ts` asserts there is no
library note, so it cannot creep back.)

Two is deliberate. A note on every control would be the same as no notes at all;
the bar for adding one is whether a new user could find that affordance without
being told — and for anything that *is* labelled, the **?** search will take you
to it.

## Finding anything: the ? search

The header's **?** button is the direct answer to "where is X?". It searches the
**feature registry** — the same data the Feature Tour walks and the notes point
at, so the three cannot drift apart from one another — and every hit says what
the thing is, how to use it, and which tab it lives in.

The part a document search cannot do is the last button on each card. A registry
entry carries a selector, so **LOCATE** hands the id to the solo spotlight: the
app switches workspace, opens the panel the control lives in, and rings the real
control on the real screen. Nothing is closed again afterwards — you asked to be
taken there.

Keyboard: the field takes focus when the popover opens, Down steps into the
results, Up comes back out of the top of them, Enter locates the best hit, and
Escape closes and hands focus back to the **?** button. With nothing typed it
shows a handful of featured entries rather than an empty list.

**Docs** sits beside the input, one click further in, and still opens the full
manual untouched. It used to be the header's only help affordance, which is
exactly the problem the search was built to fix: a 185 KB manual whose own
search filters headings by substring only answers "where is the library?" for
someone who already knows the heading is called Library.

## They retire themselves

A note disappears the first moment you use the thing it points at — open the
library once and the library note is gone for good, without your having to
dismiss it. Closing one by hand does the same thing permanently.

The state is remembered per browser, so notes do not come back on the next
launch.

## Bringing them back

The hamburger menu, under **Help**, has **Hide Feature Notes** while any note
is still on screen and **Show Feature Notes** once they have all gone. Showing
brings back *every* note, dismissed ones included — the point of the entry is
to re-find a control you have since forgotten, not only to undo an accidental
close.

## What they will not do

A note never sits on top of what it is pointing at, and the whole layer ignores
the mouse, so a note can never swallow a click meant for the control beneath
it. Positions are measured live rather than fixed, so notes follow the library
tab as the window, the dock height and the rail width change, and a control
hard against an edge of the screen still gets its card fully on screen. Each
note is wired to its target for screen readers, so the hint is not
sighted-only.
