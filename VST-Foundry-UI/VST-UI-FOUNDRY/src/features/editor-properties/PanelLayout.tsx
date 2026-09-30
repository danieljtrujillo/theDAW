import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import CollapsiblePanel from "../../components/CollapsiblePanel";

export const IsContext = React.createContext<boolean>(false);

export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
  const isContext = React.useContext(IsContext);
  if (isContext) {
    return (
      <div className="border-t border-app-border/50 pt-2 mt-2 first:border-0 first:pt-0 first:mt-0">
        <div className="text-[10px] uppercase tracking-wider text-app-muted font-bold mb-1.5">
          {title}
        </div>
        <div className="space-y-1.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="border-t border-app-border pt-3 mt-3">
      <button
        className="w-full flex items-center gap-1.5 text-xs text-app-muted font-medium hover:text-app-main transition-colors mb-2"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        {title}
      </button>
      {isOpen && <div className="space-y-3">{children}</div>}
    </div>
  );
}

export const PropertiesWrapper = ({
  children,
  extraHeader,
  isContext,
}: {
  children: React.ReactNode;
  extraHeader?: React.ReactNode;
  isContext?: boolean;
}) => {
  if (isContext) {
    return (
      <div className="w-64 max-h-[400px] overflow-y-auto bg-app-base custom-scrollbar p-2">
        {children}
      </div>
    );
  }
  return (
    <CollapsiblePanel
      title="Properties"
      defaultOpen={true}
      flex1={true}
      extraHeader={extraHeader}
    >
      {children}
    </CollapsiblePanel>
  );
};
