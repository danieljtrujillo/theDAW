import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsiblePanelProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  extraHeader?: React.ReactNode;
  flex1?: boolean;
}

export default function CollapsiblePanel({ title, children, defaultOpen = true, extraHeader, flex1 = false }: CollapsiblePanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`flex flex-col border-b border-app-border bg-app-base shrink-0 ${isOpen && flex1 ? 'flex-1 min-h-50' : ''}`}>
      <div 
        className="w-full flex items-center justify-between p-3 text-sm text-app-main hover:text-white hover:bg-app-surface-hover transition-colors shrink-0 font-medium cursor-pointer"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          {title}
        </div>
        {extraHeader && (
          <div onClick={(e) => e.stopPropagation()} className="cursor-default flex items-center">
            {extraHeader}
          </div>
        )}
      </div>
      {isOpen && (
        <div className="flex-1 overflow-y-auto flex flex-col bg-app-base/80 shadow-[inset_0_4px_6px_rgba(0,0,0,0.3)]">
          {children}
        </div>
      )}
    </div>
  );
}
