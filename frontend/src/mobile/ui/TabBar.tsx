/** Bottom tab bar. Slice 1 ships Library + Remote; DJ/VJ/MAKE tabs land in
 *  later slices. */
import type { ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  icon: ReactNode;
}

export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabDef[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="m-tabbar" aria-label="Sections">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`m-tab${active === t.id ? ' is-active' : ''}`}
          aria-current={active === t.id ? 'page' : undefined}
          onClick={() => onSelect(t.id)}
        >
          <span className="m-tab-icon">{t.icon}</span>
          <span className="m-tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
