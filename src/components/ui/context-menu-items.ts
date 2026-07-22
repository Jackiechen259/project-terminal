import type { ContextMenuItem } from "./context-menu";

/** Join non-empty menu sections with exactly one separator between them. */
export function joinContextMenuSections(
  ...sections: ContextMenuItem[][]
): ContextMenuItem[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, index) =>
      index === 0
        ? section
        : ([{ separator: true }, ...section] as ContextMenuItem[]),
    );
}
