/**
 * Global Arsenal store — a cross-project, cross-reload palette of saved
 * controls. Unlike project state (elements / canvas / assets), the Arsenal is
 * deliberately NOT part of any SavedProject or zip export: it lives under a
 * single idb-keyval key ("vst-arsenal") so a control you save once is available
 * in EVERY project and after every reload. Pure data module — no React, no DOM.
 *
 * Persistence mirrors the rest of the app (useAutosave / useProjectPersistence
 * both talk to idb-keyval). Each mutator reads the current list, applies its
 * change, writes it back, and RETURNS the updated list so callers can drop the
 * result straight into React state without a second read.
 */
import { get, set } from "idb-keyval";
import type { ElementType } from "../types";

// The single idb-keyval key the whole Arsenal lives under. Global on purpose —
// see the module header: never in project state, never in the zip export.
const ARSENAL_KEY = "vst-arsenal";

// One saved control in the Arsenal palette. `presetData` holds the
// instance-agnostic UIElement fields (NO id / x / y) so an entry drops onto any
// canvas through the existing presetData drag path unchanged. For a saved Group
// (a whole MODULE), `presetData.__module = { children }` additionally carries
// the group's children stripped of instance identity (each Image child keeps a
// resolved `__assetUrl` so the asset can be re-materialized on drop in any
// project); handleDropElement rebuilds the Group + children from it.
export interface ArsenalEntry {
  id: string; // uuid
  name: string;
  type: ElementType;
  defaultWidth: number;
  defaultHeight: number;
  presetData: Record<string, unknown>; // instance-agnostic UIElement fields (NO id/x/y)
  previewUrl?: string; // faceSrc or other thumb for the palette tile
  createdAt: number;
}

/**
 * Read the full Arsenal. Returns [] when nothing has been saved yet OR the
 * stored value is malformed — a corrupt key must not brick the palette. Never
 * throws to callers: an idb read failure degrades to an empty list.
 */
export async function loadArsenal(): Promise<ArsenalEntry[]> {
  try {
    const stored = await get<ArsenalEntry[]>(ARSENAL_KEY);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/**
 * Add an entry, or overwrite the existing one that shares its `name`. Same
 * same-name semantics as handleAddCustomModule (App.tsx): saving under a name
 * you have already used replaces that slot in place instead of piling up
 * duplicates; a fresh name appends. Returns the updated list.
 */
export async function addToArsenal(entry: ArsenalEntry): Promise<ArsenalEntry[]> {
  const list = await loadArsenal();
  const idx = list.findIndex((e) => e.name === entry.name);
  const next = idx >= 0 ? list.map((e, i) => (i === idx ? entry : e)) : [...list, entry];
  await set(ARSENAL_KEY, next);
  return next;
}

/**
 * Remove the entry with this id (a no-op if it is already gone). Returns the
 * updated list.
 */
export async function removeFromArsenal(id: string): Promise<ArsenalEntry[]> {
  const list = await loadArsenal();
  const next = list.filter((e) => e.id !== id);
  await set(ARSENAL_KEY, next);
  return next;
}
