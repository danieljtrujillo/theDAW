# Feature Notes

Feature Notes are small labels pinned beside the few controls in theDAW that
carry no label of their own. Each one is a card with the name of the thing, one
line saying what it is and how to open it, a pointer at the control itself, and
a close button.

They exist because of a real report: someone spent a long time hunting for the
Library, read the docs and asked the assistant, and only found it by eventually
noticing the slim tab on the right edge of the window. The feature tour did not
save them, and structurally cannot — a tour is a sequence you click through
once and then it is gone, so it teaches nothing about an affordance you next
meet three sessions later. A note stays pinned to the thing until you have
actually used it.

## The three notes

| Note | Points at |
|---|---|
| **Library** | The slim tab on the right edge of the window that slides the library out. |
| **Log** | The LOG strip at the bottom right — machine stats and every job the app has run. |
| **Panels** | The bottom strip that opens the panel tabs: Score, Sing, Lyric, Levels, MIDI and the rest. |

Three is deliberate. A note on every control would be the same as no notes at
all; the bar for adding one is whether a new user could find that affordance
without being told.

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
