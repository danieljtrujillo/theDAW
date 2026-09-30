import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

interface KeyboardOptions {
  isOpen: boolean;
  selectionCount: number;
  deleteSelected: () => void;
  isEditingMask: boolean;
}

export function useExtractorKeyboard({ isOpen, selectionCount, deleteSelected, isEditingMask }: KeyboardOptions) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isOpen || (event.key !== "Delete" && event.key !== "Backspace")) return;
    event.stopPropagation();
    if (event.defaultPrevented || event.nativeEvent.isComposing || isEditingMask) return;
    const target = event.target;
    if (target instanceof HTMLElement && (
      target.closest("input, textarea, select") || target.isContentEditable ||
      target.closest('[contenteditable]:not([contenteditable="false"])')
    )) return;
    if (selectionCount === 0) return;
    event.preventDefault();
    deleteSelected();
  };

  return { dialogRef, onKeyDown };
}
