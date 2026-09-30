import { useState } from "react";
import type { ReactNode } from "react";
import { Boxes, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import type { ExtractedElement, ExtractedPanel } from "../../lib/extractor/types";
import type { ElementType } from "../../types";

export interface ModuleCardProps {
  panel: ExtractedPanel;
  elements: ExtractedElement[];
  selectionFor: (element: ExtractedElement) => ElementType;
  renderCard: (element: ExtractedElement) => ReactNode;
  onPlaceModule: (panel: ExtractedPanel, items: { el: ExtractedElement; controlType: ElementType }[]) => void;
  onDeletePanel: (id: string) => void;
}

export function ModuleCard({ panel, elements, selectionFor, renderCard, onPlaceModule, onDeletePanel }: ModuleCardProps) {
  const members = elements.filter((el) => el.panelId === panel.id);
  const [open, setOpen] = useState(false);
  // Placement needs every member fully processed (labeled) so each control
  // has a cutout/face; an empty panel has nothing to place.
  const allLabeled =
    members.length > 0 && members.every((el) => el.status === "labeled");
  const placeDisabled = !allLabeled;
  const placeTitle = placeDisabled
    ? members.length === 0
      ? "No pieces detected in this module yet"
      : "Every piece must finish processing before the module can be placed — run Process Pending"
    : "Place this whole module — backplate + its pieces — onto the canvas as one Group";
  const pieceLabel = `${members.length} piece${members.length === 1 ? "" : "s"}`;

  return (
    <div
      key={panel.id}
      className="border-2 border-app-accent/40 rounded-lg overflow-hidden bg-app-surface shadow-sm"
    >
      {/* Module card head */}
      <div className="flex items-start gap-2.5 p-2.5">
        <div className="w-14 h-14 rounded bg-app-base/60 border border-app-border overflow-hidden shrink-0 flex items-center justify-center">
          {panel.cropDataUrl ? (
            <img
              src={panel.cropDataUrl}
              alt={panel.title}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <Boxes className="w-6 h-6 text-app-accent/70" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="px-1.5 py-0.5 rounded bg-app-accent/20 text-app-accent text-[9px] font-bold uppercase tracking-wide">
              Module
            </span>
            <span className="text-[11px] text-app-muted font-mono shrink-0">
              {pieceLabel}
            </span>
            {panel.status === "scanning" && (
              <Loader2 className="w-3 h-3 animate-spin text-purple-400 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => onDeletePanel(panel.id)}
              aria-label={"Delete module " + panel.title}
              title={"Delete module (keeps its pieces as loose assets)"}
              className="ml-auto text-app-muted hover:text-red-400 shrink-0 p-0.5 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="text-sm font-semibold text-app-main truncate">
            {panel.title}
          </div>

          <div className="flex items-center gap-1.5 mt-0.5">
            <button
              type="button"
              onClick={() =>
                onPlaceModule(
                  panel,
                  members.map((el) => ({
                    el,
                    controlType: selectionFor(el),
                  })),
                )
              }
              disabled={placeDisabled}
              title={placeTitle}
              className="btn-3d text-white text-xs flex items-center gap-1.5 disabled:opacity-50 py-1 px-2.5 rounded"
            >
              <Boxes className="w-3.5 h-3.5" />
              Place as Group
            </button>
            <button
              type="button"
              onClick={() => setOpen((previous) => !previous)}
              aria-expanded={open}
              aria-label={
                (open ? "Hide" : "Edit") + " pieces of module " + panel.title
              }
              title={open ? "Hide pieces" : "Edit the individual pieces"}
              className="text-xs text-app-muted hover:text-app-main flex items-center gap-1 py-1 px-1.5 rounded border border-app-border hover:bg-app-surface-hover transition-colors"
            >
              {open ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
              {open ? "Hide" : "Pieces"}
            </button>
          </div>
          {placeDisabled && members.length > 0 && (
            <div className="text-[10px] text-amber-400/90 mt-0.5">
              Run “Process Pending” to enable group placement.
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="p-3 pt-2 space-y-4 border-t border-app-border/60 bg-app-base/40">
          <div className="text-[10px] text-app-muted uppercase tracking-wide font-semibold">
            Pieces in this module
          </div>
          {members.length > 0 ? (
            members.map((el) => renderCard(el))
          ) : (
            <div className="text-[11px] text-app-muted italic">
              No pieces detected in this module yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
