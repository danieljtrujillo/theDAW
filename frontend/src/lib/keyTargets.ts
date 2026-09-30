/**
 * Does a key press belong to the control that has focus?
 *
 * Global shortcut handlers used to bail out whenever the event target was ANY `<input>`. A fader
 * is an `<input type="range">` and keeps keyboard focus after it is moved, so after every fader
 * ride the app's shortcuts went dead until the user clicked somewhere else: Ctrl+Z would not undo
 * the ride it had just made, Space would not play, Ctrl+S fell through to the browser's own
 * "save page" dialog.
 *
 * The rule here is per KEY, not per element: a control only keeps the keys it actually uses.
 *
 *  - a text field, a textarea, a select, anything contenteditable: every key (typing, the
 *    field's own undo, type-to-jump in a dropdown)
 *  - a range slider: the keys that move it — arrows, Home, End, PageUp, PageDown
 *  - a checkbox or radio: Space (and the arrows, which walk a radio group)
 *  - any other input (button, color, file…): Space and Enter, which activate it
 *
 * Everything else goes to the app.
 */

/** `<input>` types the user types INTO. An input with no/unknown type is a text field. */
const NON_TEXT_INPUT_TYPES = new Set([
  'range',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'color',
  'file',
  'image',
  'hidden',
]);

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** The minimum of an element this needs, so tests can pass plain objects. */
interface TargetLike {
  closest?: (selector: string) => unknown;
}
interface InputLike {
  type?: string;
  getAttribute?: (name: string) => string | null;
}

export function keyBelongsToFocusedControl(e: { key: string; target: EventTarget | null }): boolean {
  const target = e.target as TargetLike | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (target.closest('textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  const input = target.closest('input') as InputLike | null;
  if (!input) return false;
  const type = (input.type ?? input.getAttribute?.('type') ?? 'text').toLowerCase();
  if (!NON_TEXT_INPUT_TYPES.has(type)) return true; // a field the user types into
  if (type === 'range') return SLIDER_KEYS.has(e.key);
  if (type === 'checkbox') return e.key === ' ';
  if (type === 'radio') return e.key === ' ' || ARROW_KEYS.has(e.key);
  if (type === 'hidden') return false;
  return e.key === ' ' || e.key === 'Enter';
}
