import { useEffect, useRef } from "react";
import type { OnChange, OnMount } from "@monaco-editor/react";
import { UIElement } from "../../types";
import type { UpdateElementsFn } from "./useElementField";

/**
 * RAW JSON editor helpers extracted from CompactElementProperties. This
 * preserves the recent fixes verbatim:
 *   - debounced commit while typing (RAW_EDIT_DEBOUNCE_MS)
 *   - flush-on-blur and flush-on-unmount
 *   - stale-snapshot per-key diff commit (only changed keys are written,
 *     `id` is never written, JSON syntax errors while typing are ignored)
 */

export const RAW_EDIT_DEBOUNCE_MS = 400;

/**
 * Diff a parsed RAW JSON object against the current element and commit only the
 * keys that actually changed (ignoring `id`). Silently ignores JSON syntax
 * errors so partial edits mid-type don't throw.
 */
export function commitRawEdit(
  val: string,
  current: UIElement,
  onUpdate: UpdateElementsFn,
): void {
  try {
    const parsed = JSON.parse(val);
    const updates: Record<string, any> = {};
    Object.keys(parsed).forEach((key) => {
      if (key === "id") return;
      if (
        JSON.stringify(parsed[key]) !== JSON.stringify((current as any)[key])
      ) {
        updates[key] = parsed[key];
      }
    });
    if (Object.keys(updates).length > 0) {
      onUpdate([current.id], updates);
    }
  } catch (e) {
    // Ignore syntax errors while typing
  }
}

/**
 * Wires the debounce/flush/diff lifecycle for the Monaco RAW editor and returns
 * the `onChange`/`onMount` handlers to hand to `<Editor>`. Uses refs so the
 * always-latest `element`/`onUpdateElements` are read at commit time, exactly
 * as the original component did.
 */
export function useRawJsonEditor(
  element: UIElement,
  onUpdateElements: UpdateElementsFn,
): { handleEditorChange: OnChange; handleEditorMount: OnMount } {
  const rawEditDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const elementRef = useRef(element);
  elementRef.current = element;
  const onUpdateElementsRef = useRef(onUpdateElements);
  onUpdateElementsRef.current = onUpdateElements;
  const pendingRawRef = useRef<string | null>(null);

  const flushRawEdit = () => {
    if (rawEditDebounceRef.current) {
      clearTimeout(rawEditDebounceRef.current);
      rawEditDebounceRef.current = null;
    }
    if (pendingRawRef.current !== null) {
      commitRawEdit(
        pendingRawRef.current,
        elementRef.current,
        onUpdateElementsRef.current,
      );
      pendingRawRef.current = null;
    }
  };

  const flushRawEditRef = useRef(flushRawEdit);
  flushRawEditRef.current = flushRawEdit;

  useEffect(
    () => () => {
      flushRawEditRef.current();
    },
    [],
  );

  const handleEditorChange: OnChange = (val) => {
    if (!val) return;
    pendingRawRef.current = val;
    if (rawEditDebounceRef.current) {
      clearTimeout(rawEditDebounceRef.current);
    }
    rawEditDebounceRef.current = setTimeout(() => {
      commitRawEdit(val, elementRef.current, onUpdateElementsRef.current);
      pendingRawRef.current = null;
      rawEditDebounceRef.current = null;
    }, RAW_EDIT_DEBOUNCE_MS);
  };

  const handleEditorMount: OnMount = (editor) => {
    editor.onDidBlurEditorText(() => {
      flushRawEditRef.current();
    });
  };

  return { handleEditorChange, handleEditorMount };
}
