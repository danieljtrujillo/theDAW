import { UIElement } from "../types";

// Clone a set of elements with fresh ids, keeping group/child references
// internally consistent. Root elements are nudged by (20, 20); grouped children
// keep their relative position but adopt their group's remapped id.
export function remapCopiedElements(source: UIElement[]): UIElement[] {
  // Map old ids to new ids to maintain group references
  const idMap = new Map<string, string>();
  source.forEach((el) =>
    idMap.set(el.id, Math.random().toString(36).substring(2, 9)),
  );

  return source.map((el) => {
    const newEl = {
      ...el,
      id: idMap.get(el.id)!,
      name: `${el.name}_copy`,
    };
    if (!el.groupId) {
      // Only offset root elements
      newEl.x += 20;
      newEl.y += 20;
    } else if (el.groupId && idMap.has(el.groupId)) {
      newEl.groupId = idMap.get(el.groupId);
    }
    if (el.type === "Group" && el.childrenIds) {
      newEl.childrenIds = el.childrenIds.map((cid) => idMap.get(cid) || cid);
    }
    return newEl;
  });
}

// Gather the selected elements plus, for any Group among them, that group's
// children — deduped by id. Copying a group must pull its children along, and
// the dedupe (recent bug fix) prevents a child that is both selected AND a group
// member from being included twice. Shared by Ctrl+C, context-menu Copy, and
// context-menu Duplicate so all three stay in lockstep.
export function collectWithGroupChildren(
  elements: UIElement[],
  selectedIds: string[],
): UIElement[] {
  const selected = elements.filter((el) => selectedIds.includes(el.id));
  let result = [...selected];
  selected.forEach((c) => {
    if (c.type === "Group" && c.childrenIds) {
      const children = elements.filter((el) => c.childrenIds!.includes(el.id));
      result = [...result, ...children];
    }
  });
  return Array.from(new Map(result.map((e) => [e.id, e])).values());
}
