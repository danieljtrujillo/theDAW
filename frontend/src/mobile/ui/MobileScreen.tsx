/** Fixed-viewport shell: [header][content 1fr][tab bar], zero page scroll.
 *  Only a <Scroller> inside `children` is allowed to scroll. */
import type { ReactNode } from 'react';

export function MobileScreen({
  header,
  children,
  tabBar,
}: {
  header?: ReactNode;
  children: ReactNode;
  tabBar?: ReactNode;
}) {
  return (
    <div className="m-screen">
      {header ? <header className="m-header">{header}</header> : <div />}
      <div className="m-content">{children}</div>
      {tabBar ?? <div />}
    </div>
  );
}
