import React, { useRef, useState } from "react";
import { Texture } from "../types";
import { X, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import CollapsiblePanel from "./CollapsiblePanel";

interface TextureManagerProps {
  textures: Texture[];
  onAddTexture: (texture: Texture) => void;
  onDeleteTexture: (id: string) => void;
  onOpenGenerateModal: () => void;
}

export default function TextureManager({
  textures,
  onAddTexture,
  onDeleteTexture,
  onOpenGenerateModal,
}: TextureManagerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedTextureId, setSelectedTextureId] = useState<string | null>(
    null,
  );
  // Compact thumbnails by default (4-up = quarter the area of the old 2-up);
  // the header zoom button toggles back to the large 2-up grid.
  const [largeThumbs, setLargeThumbs] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      const reader = new FileReader();
      let dataUrl: string;
      try {
        dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = (ev) => resolve(ev.target?.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      } catch (err) {
        console.warn(`Failed to read file "${file.name}", skipping.`, err);
        continue;
      }

      try {
        const resp = await fetch('/api/textures/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, name: file.name }),
        });
        if (resp.ok) {
          const { id, name, url } = await resp.json();
          onAddTexture({ id, name, url });
        } else {
          // Fallback to data URL if server upload fails
          onAddTexture({
            id: Math.random().toString(36).substring(2, 9),
            name: file.name,
            url: dataUrl,
          });
        }
      } catch {
        // Fallback to data URL
        onAddTexture({
          id: Math.random().toString(36).substring(2, 9),
          name: file.name,
          url: dataUrl,
        });
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <CollapsiblePanel
      title="Texture Library"
      defaultOpen={true}
      flex1={true}
      extraHeader={
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLargeThumbs((v) => !v);
            }}
            aria-pressed={largeThumbs}
            aria-label={largeThumbs ? "Smaller thumbnails" : "Larger thumbnails"}
            className="btn-3d text-white p-1 rounded"
            title={largeThumbs ? "Smaller thumbnails" : "Larger thumbnails"}
          >
            {largeThumbs ? (
              <ZoomOut className="w-3 h-3" />
            ) : (
              <ZoomIn className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onOpenGenerateModal(); }}
            className="btn-3d text-white p-1 rounded text-[10px] px-2 uppercase font-bold flex items-center gap-1"
            title="Generate texture with AI"
          >
            <Wand2 className="w-3 h-3" />
            Gen
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
            className="btn-3d text-white p-1 rounded text-[10px] px-2 uppercase font-bold"
          >
            Upload
          </button>
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto p-2">
        <input
          type="file"
          multiple
          accept="image/*"
          ref={fileInputRef}
          className="hidden"
          onChange={handleFileUpload}
        />
        <div
          className={`grid ${largeThumbs ? "grid-cols-2" : "grid-cols-4"} gap-2`}
          onClick={() => setSelectedTextureId(null)}
        >
          {textures.map((texture) => (
            <div
              key={texture.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "application/x-vst-texture",
                  JSON.stringify({ id: texture.id }),
                );
              }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedTextureId(texture.id);
              }}
              className={`relative group bg-app-surface border ${selectedTextureId === texture.id ? "border-app-accent" : "border-app-border"} rounded overflow-hidden aspect-square flex items-center justify-center cursor-grab active:cursor-grabbing`}
            >
              <img
                src={texture.url}
                alt={texture.name}
                className="max-w-full max-h-full object-contain pointer-events-none"
              />
              {texture.isGenerated && (
                <div className="absolute top-1 left-1">
                  <Wand2 className="w-3 h-3 text-app-accent drop-shadow" />
                </div>
              )}
              {selectedTextureId === texture.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        "Are you sure you want to delete this texture?",
                      )
                    ) {
                      onDeleteTexture(texture.id);
                      setSelectedTextureId(null);
                    }
                  }}
                  className="absolute top-1 right-1 bg-red-900/80 hover:bg-red-800 text-white p-1 rounded-full z-10"
                >
                  <X size={12} />
                </button>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-[9px] text-white px-1 truncate pointer-events-none">
                {texture.name}
              </div>
            </div>
          ))}
          {textures.length === 0 && (
            <div className="col-span-full text-xs text-app-muted text-center p-4 border border-dashed border-app-border rounded">
              Upload textures to use as backgrounds.
            </div>
          )}
        </div>
      </div>
    </CollapsiblePanel>
  );
}
