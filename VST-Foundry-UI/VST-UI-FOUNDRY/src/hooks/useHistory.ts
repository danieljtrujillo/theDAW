import { useState, useCallback } from 'react';
import { UIElement } from '../types';

export function useHistory(initialState: UIElement[]) {
  const [state, setState] = useState<{
    past: UIElement[][];
    present: UIElement[];
    future: UIElement[][];
  }>({
    past: [],
    present: initialState,
    future: [],
  });

  const setPresent = useCallback((newPresent: UIElement[] | ((prev: UIElement[]) => UIElement[])) => {
    setState((curr) => {
      const nextPresent = typeof newPresent === 'function' ? newPresent(curr.present) : newPresent;
      if (nextPresent === curr.present) return curr;
      return {
        past: [...curr.past, curr.present].slice(-100),
        present: nextPresent,
        future: [],
      };
    });
  }, []);

  // Update the present WITHOUT recording an undo step or clearing redo. For
  // automatic, non-user mutations (e.g. a CustomCode element self-registering
  // its parameter schema on load) that must not pollute the undo/redo stacks.
  const setPresentWithoutHistory = useCallback(
    (newPresent: UIElement[] | ((prev: UIElement[]) => UIElement[])) => {
      setState((curr) => {
        const nextPresent =
          typeof newPresent === 'function' ? newPresent(curr.present) : newPresent;
        return { ...curr, present: nextPresent };
      });
    },
    [],
  );

  const undo = useCallback(() => {
    setState((curr) => {
      if (curr.past.length === 0) return curr;
      const previous = curr.past[curr.past.length - 1];
      const newPast = curr.past.slice(0, curr.past.length - 1);
      return {
        past: newPast,
        present: previous,
        future: [curr.present, ...curr.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((curr) => {
      if (curr.future.length === 0) return curr;
      const next = curr.future[0];
      const newFuture = curr.future.slice(1);
      return {
        past: [...curr.past, curr.present],
        present: next,
        future: newFuture,
      };
    });
  }, []);

  const clearHistory = useCallback((newPresent: UIElement[]) => {
      setState({
          past: [],
          present: newPresent,
          future: []
      })
  }, []);

  return {
    elements: state.present,
    setElements: setPresent,
    setElementsWithoutHistory: setPresentWithoutHistory,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    clearHistory
  };
}
