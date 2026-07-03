import { labelCls } from './constants';
import { GeneratedTexture } from './types';

interface ResultsGridProps {
  results: GeneratedTexture[];
}

// Grid of freshly generated images (immediate "Generate" path). Extracted
// verbatim from the original TextureGenerateModal.tsx; renders nothing when
// there are no results (matching the original `results.length > 0 &&` guard).
export default function ResultsGrid({ results }: ResultsGridProps) {
  if (results.length === 0) return null;

  return (
    <div>
      <div className={labelCls}>Generated ({results.length})</div>
      <div className="grid grid-cols-4 gap-2">
        {results.map((r) => (
          <div
            key={r.id}
            className="relative aspect-square bg-app-surface border border-app-border rounded overflow-hidden flex items-center justify-center"
            title={r.name}
          >
            <img
              src={r.url}
              alt={r.name}
              className="max-w-full max-h-full object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
