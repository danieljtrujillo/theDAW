import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, GripHorizontal } from 'lucide-react';

interface SectionProps {
  title: string;
  icon?: any;
  rightNode?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  resizable?: boolean;
  minHeight?: number;
}

export const Section: React.FC<SectionProps> = ({ 
  title, 
  icon: Icon, 
  rightNode, 
  defaultOpen = false, 
  children,
  resizable = true,
  minHeight = 80
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [height, setHeight] = useState<number | string>('auto');
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newHeight = Math.max(minHeight, e.clientY - rect.top);
      setHeight(newHeight);
    };

    const handleMouseUp = () => setIsResizing(false);

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
    } else {
      document.body.style.cursor = 'default';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizing, minHeight]);

  return (
    <div className="hardware-card flex flex-col shrink-0 relative mb-1 last:mb-0">
       <div 
         className="flex items-center justify-between px-2 py-1.5 cursor-pointer select-none bg-white/2 hover:bg-white/5 transition-colors" 
         onClick={() => setIsOpen(!isOpen)}
       >
          <div className="flex items-center gap-2">
             {Icon && <Icon className="w-3.5 h-3.5 text-purple-400" />}
             <span className="mono-label text-[10px]!">{title}</span>
          </div>
          <div className="flex items-center gap-2">
             {rightNode}
             <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
          </div>
       </div>
       <AnimatePresence>
         {isOpen && (
           <motion.div
             initial={{ height: 0, opacity: 0 }}
             animate={{ height: height === 'auto' ? 'auto' : height, opacity: 1 }}
             exit={{ height: 0, opacity: 0 }}
             className="overflow-hidden flex flex-col"
             ref={containerRef}
           >
              <div 
                className="flex flex-col gap-2 pt-2 border-t border-white/5 overflow-y-auto p-2 flex-1 no-scrollbar overflow-x-hidden" 
                style={{ maxHeight: '800px' }}
              >
                {children}
              </div>
              {resizable && (
                <div 
                  className="h-1.5 cursor-row-resize hover:bg-purple-500/20 transition-colors flex items-center justify-center group relative mt-1"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsResizing(true);
                  }}
                >
                  <div className="w-8 h-0.5 bg-zinc-800 rounded-full group-hover:bg-purple-500/50" />
                </div>
              )}
           </motion.div>
         )}
       </AnimatePresence>
    </div>
  );
};
