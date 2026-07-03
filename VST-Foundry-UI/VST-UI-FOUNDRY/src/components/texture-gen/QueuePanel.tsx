import { Loader2, CheckCircle, AlertCircle, X } from 'lucide-react';
import { QueueItem } from './types';

interface QueuePanelProps {
  queue: QueueItem[];
  onClearDone: () => void;
  onRemoveItem: (id: string) => void;
}

// Queue list with per-item status, result thumbnails and remove controls.
// Extracted verbatim from the original TextureGenerateModal.tsx; renders
// nothing when the queue is empty (matching the original `queue.length > 0 &&`
// guard).
export default function QueuePanel({ queue, onClearDone, onRemoveItem }: QueuePanelProps) {
  if (queue.length === 0) return null;

  return (
    <div className="border border-app-border rounded">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border bg-app-surface">
        <span className="text-[10px] uppercase font-bold text-app-muted tracking-wide">
          Queue ({queue.filter((i) => i.status === 'pending').length} pending)
        </span>
        <button
          onClick={onClearDone}
          className="text-[10px] text-app-muted hover:text-app-main uppercase font-bold transition-colors"
        >
          Clear done
        </button>
      </div>
      <div className="divide-y divide-app-border max-h-64 overflow-y-auto">
        {queue.map((item) => (
          <div key={item.id} className="flex items-center gap-2 px-3 py-2">
            {item.status === 'running' ? (
              <Loader2 className="w-3.5 h-3.5 text-app-accent animate-spin shrink-0" />
            ) : item.status === 'done' ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-400 shrink-0" />
            ) : item.status === 'error' ? (
              <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            ) : (
              <span className="w-3.5 h-3.5 rounded-full border border-app-border shrink-0" />
            )}
            <span className="flex-1 text-xs text-app-main truncate" title={item.label}>
              {item.label}
            </span>
            {item.results && item.results.length > 0 && (
              <div className="flex gap-1">
                {item.results.slice(0, 3).map((r) => (
                  <div key={r.id} className="w-8 h-8 bg-app-surface border border-app-border rounded overflow-hidden shrink-0">
                    <img
                      src={r.url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  </div>
                ))}
                {item.results.length > 3 && (
                  <div className="w-8 h-8 bg-app-surface border border-app-border rounded flex items-center justify-center text-[9px] text-app-muted shrink-0">
                    +{item.results.length - 3}
                  </div>
                )}
              </div>
            )}
            {item.error && (
              <span className="text-[10px] text-red-400 truncate max-w-30" title={item.error}>
                {item.error}
              </span>
            )}
            {item.status !== 'running' && (
              <button
                onClick={() => onRemoveItem(item.id)}
                className="text-app-muted hover:text-red-400 transition-colors shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
