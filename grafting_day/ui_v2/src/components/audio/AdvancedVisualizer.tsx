/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Activity, Zap, Waves, Target, Maximize2, Settings2 } from 'lucide-react';

export const AdvancedVisualizer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'oscilloscope' | 'spectrum' | 'radial'>('oscilloscope');
  const requestRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = (time: number) => {
      const width = canvas.width;
      const height = canvas.height;

      // Clear with slight trail
      ctx.fillStyle = 'rgba(7, 5, 10, 0.2)';
      ctx.fillRect(0, 0, width, height);

      if (mode === 'oscilloscope') {
        ctx.beginPath();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#8b5cf6';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#8b5cf6';

        for (let x = 0; x < width; x++) {
          const y = height / 2 + Math.sin(x * 0.05 + time * 0.01) * 20 * Math.sin(time * 0.002) + (Math.random() - 0.5) * 5;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (mode === 'spectrum') {
        const barWidth = width / 64;
        for (let i = 0; i < 64; i++) {
          const h = Math.abs(Math.sin(i * 0.2 + time * 0.01)) * height * 0.8;
          const x = i * barWidth;
          
          const gradient = ctx.createLinearGradient(0, height, 0, height - h);
          gradient.addColorStop(0, '#8b5cf6');
          gradient.addColorStop(1, '#a855f7');
          
          ctx.fillStyle = gradient;
          ctx.fillRect(x, height - h, barWidth - 1, h);
        }
      } else {
        // Radial
        const centerX = width / 2;
        const centerY = height / 2;
        ctx.beginPath();
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 1;
        for (let i = 0; i < 360; i += 2) {
          const angle = (i * Math.PI) / 180;
          const r = 50 + Math.abs(Math.sin(i * 0.1 + time * 0.01)) * 30;
          const x = centerX + Math.cos(angle) * r;
          const y = centerY + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      requestRef.current = requestAnimationFrame(render);
    };

    requestRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(requestRef.current);
  }, [mode]);

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 relative overflow-hidden group">
      {/* Background Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none" 
        style={{ 
          backgroundImage: `linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)`,
          backgroundSize: '20px 20px'
        }} 
      />

      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 z-10">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-purple-400" />
          <span className="mono-label">Signal / Scope</span>
        </div>
        
        <div className="flex gap-1">
           {(['oscilloscope', 'spectrum', 'radial'] as const).map(m => (
             <button 
               key={m}
               onClick={() => setMode(m)}
               className={`p-1 px-1.5 rounded text-[8px] uppercase font-black transition-colors ${mode === m ? 'bg-purple-600 text-white' : 'text-zinc-600 hover:text-zinc-400'}`}
             >
               {m.charAt(0)}
             </button>
           ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        <canvas 
          ref={canvasRef} 
          width={400} 
          height={200} 
          className="w-full h-full"
        />
        
        {/* Overlay HUD */}
        <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
           <div className="flex items-center gap-2 bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
              <Zap className="w-2.5 h-2.5 text-yellow-500" />
              <span className="text-[7px] font-mono text-zinc-400">GAIN: +2.4dB</span>
           </div>
           <div className="flex items-center gap-2 bg-black/60 px-1.5 py-0.5 rounded border border-white/5">
              <Target className="w-2.5 h-2.5 text-emerald-500" />
              <span className="text-[7px] font-mono text-zinc-400">PEAK: -0.1dB</span>
           </div>
        </div>

        <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
           <button className="p-1 hover:bg-white/10 rounded text-zinc-600 transition-colors"><Settings2 className="w-3 h-3" /></button>
           <button className="p-1 hover:bg-white/10 rounded text-zinc-600 transition-colors"><Maximize2 className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="h-4 border-t border-white/5 bg-black/60 flex items-center justify-between px-2">
         <span className="text-[7px] font-mono text-zinc-700 uppercase italic">Hardware Accelerated Engine</span>
         <div className="flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-purple-500 animate-pulse" />
            <span className="text-[7px] font-mono text-purple-900 font-black">L-R SYNC</span>
         </div>
      </div>
    </div>
  );
};
