import { Boxes, Layers } from "lucide-react";
import type { ExtractedPanel } from "../../lib/extractor/types";
import { ModuleCard, type ModuleCardProps } from "./ModuleCard";

type ModuleSectionsProps = Omit<ModuleCardProps, "panel"> & { panels: ExtractedPanel[] };

export function ModuleSections({ panels, elements, renderCard, ...actions }: ModuleSectionsProps) {
  const panelIds = new Set(panels.map((panel) => panel.id));
  const looseElements = elements.filter((element) => !element.panelId || !panelIds.has(element.panelId));
  return <>
    {panels.length > 0 && <>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-app-muted">
        <Boxes className="w-3.5 h-3.5" />Modules ({panels.length})
      </div>
      {panels.map((panel) => <ModuleCard key={panel.id} panel={panel} elements={elements} renderCard={renderCard} {...actions} />)}
    </>}
    {looseElements.length > 0 && <>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-app-muted pt-1">
        <Layers className="w-3.5 h-3.5" />Individual Pieces ({looseElements.length})
      </div>
      {looseElements.slice().reverse().map(renderCard)}
    </>}
  </>;
}
