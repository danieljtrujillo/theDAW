import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isPlaying: boolean;
  color?: string;
}

export const Visualizer: React.FC<VisualizerProps> = ({ isPlaying, color = '#8b5cf6' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bars = 64;
    const barWidth = canvas.width / bars;
    const data = new Array(bars).fill(0).map(() => Math.random());

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.5, '#c084fc');
      gradient.addColorStop(1, '#e879f9');

      for (let i = 0; i < bars; i++) {
        // Simple faux-audio simulation if playing
        if (isPlaying) {
          data[i] = Math.max(0.1, Math.min(1, data[i] + (Math.random() - 0.5) * 0.15));
        } else {
          data[i] = Math.max(0.05, data[i] * 0.9);
        }

        const h = data[i] * (canvas.height - 4);
        const x = i * barWidth;
        const y = (canvas.height - h) / 2; // Center vertically

        ctx.fillStyle = gradient;
        
        // Draw rounded bars
        const r = 1;
        ctx.beginPath();
        ctx.roundRect(x + 0.5, y, barWidth - 1, h, r);
        ctx.fill();
        
        // Add a subtle glow to active bars
        if (isPlaying && h > canvas.height * 0.5) {
          ctx.shadowBlur = 10;
          ctx.shadowColor = color;
        } else {
          ctx.shadowBlur = 0;
        }
      }

      requestRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={200} 
      height={40} 
      className="opacity-50 grayscale hover:grayscale-0 transition-all duration-500"
    />
  );
};
