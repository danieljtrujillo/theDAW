/** The one scrollable region inside a MobileScreen's content slot. */
import type { ReactNode } from 'react';

export function Scroller({ children }: { children: ReactNode }) {
  return <div className="m-scroller">{children}</div>;
}
