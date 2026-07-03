/**
 * React surface for the theDAW control bus (Feature A).
 *
 * Starts the shared bus on first mount (it stays open for the app's lifetime —
 * multiple consumers share one socket) and exposes the live snapshot plus the
 * dispatch function. Built on useSyncExternalStore so any manifest re-publish
 * from theDAW re-renders consumers with the fresh target list.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  getDawBusSnapshot,
  setDawTarget,
  startDawControlBus,
  subscribeDawBus,
  type DawBusSnapshot,
  type DawControlValue,
} from "../lib/dawControlBus";
import { startVstBindRuntime } from "../lib/vstBindRuntime";

export interface DawBindings {
  /** True while the WS to theDAW's control relay is open. */
  connected: boolean;
  /** Live bindable-target manifest (re-published by theDAW as it grows). */
  targets: DawBusSnapshot["targets"];
  /** Drive one target: scaled number for continuous, boolean for toggles. */
  setTarget: (id: string, value: DawControlValue) => void;
}

export function useDawBindings(): DawBindings {
  const snapshot = useSyncExternalStore(subscribeDawBus, getDawBusSnapshot);

  useEffect(() => {
    // Shared, idempotent — intentionally never stopped on unmount so the
    // manifest stays warm across panel opens/closes. The built-in bind
    // runtime (LFOs / macros / local transport) rides along for `vst:` ids.
    startDawControlBus();
    startVstBindRuntime();
  }, []);

  return {
    connected: snapshot.connected,
    targets: snapshot.targets,
    setTarget: setDawTarget,
  };
}
