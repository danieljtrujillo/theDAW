import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';

interface ResizablePanelProps {
  children: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  position?: 'left' | 'right';
  title?: string;
  isOpen?: boolean;
  onToggle?: () => void;
}

export const ResizablePanel: React.FC<ResizablePanelProps> = ({
  children,
  defaultWidth = 320,
  minWidth = 240,
  maxWidth = 600,
  position = 'left',
  title,
  isOpen = true,
  onToggle,
}) => {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      let newWidth = width;
      if (position === 'left') {
        newWidth = e.clientX - (resizeRef.current?.getBoundingClientRect().left || 0);
      } else {
        newWidth = window.innerWidth - e.clientX;
      }
      
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    } else {
      document.body.style.cursor = 'default';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizing, position, width, minWidth, maxWidth]);

  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          className={`h-full flex flex-col bg-[#0d0b16] border-white/5 relative shadow-2xl z-20 ${position === 'left' ? 'border-r' : 'border-l'}`}
        >
          {title && (
            <div className="h-10 border-b border-white/5 flex items-center justify-between px-3 bg-black/20 flex-shrink-0">
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300">{title}</span>
              {onToggle && (
                 <button onClick={onToggle} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors">
                    {position === 'left' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                 </button>
              )}
            </div>
          )}
          <div className="flex-1 overflow-hidden" ref={resizeRef}>
             {children}
          </div>
          
          {/* Resize Handle */}
          <div 
            className={`absolute top-0 bottom-0 w-2 cursor-col-resize flex items-center justify-center group hover:bg-white/5 transition-colors z-50 ${position === 'left' ? '-right-1' : '-left-1'}`}
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizing(true);
            }}
          >
             <div className="w-0.5 h-8 bg-white/10 group-hover:bg-purple-500/50 rounded-full transition-colors" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
