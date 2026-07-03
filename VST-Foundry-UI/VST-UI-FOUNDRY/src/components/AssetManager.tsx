import React, { useRef, useState } from "react";
import { Asset } from "../types";
import { X, Wand2, ZoomIn, ZoomOut } from "lucide-react";
import CollapsiblePanel from "./CollapsiblePanel";

interface AssetManagerProps {
  assets: Asset[];
  onAddAsset: (asset: Asset) => void;
  onDeleteAsset: (id: string) => void;
  onAddToCanvas: (asset: Asset) => void;
  onOpenGenerateModal?: () => void;
}

export default function AssetManager({
  assets,
  onAddAsset,
  onDeleteAsset,
  onAddToCanvas,
  onOpenGenerateModal,
}: AssetManagerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // Compact thumbnails by default (4-up = quarter the area of the old 2-up);
  // the header zoom button toggles back to the large 2-up grid.
  const [largeThumbs, setLargeThumbs] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          const url = ev.target.result as string;
          const img = new window.Image();
          img.onload = () => {
            onAddAsset({
              id: Math.random().toString(36).substring(2, 9),
              name: file.name,
              url: url,
              width: img.width,
              height: img.height,
            });
          };
          img.src = url;
        }
      };
      reader.readAsDataURL(file);
    });

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragStart = (e: React.DragEvent, asset: Asset) => {
    e.dataTransfer.setData("elementType", "Image");
    e.dataTransfer.setData("assetId", asset.id);
    e.dataTransfer.setData("assetUrl", asset.url);
    e.dataTransfer.setData("defaultWidth", (asset.width || 100).toString());
    e.dataTransfer.setData("defaultHeight", (asset.height || 100).toString());
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <CollapsiblePanel
      title="Asset Library"
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
          {onOpenGenerateModal && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpenGenerateModal();
              }}
              className="btn-3d text-white p-1 rounded text-[10px] px-2 uppercase font-bold flex items-center gap-1"
              title="Generate asset with AI"
            >
              <Wand2 className="w-3 h-3" />
              Gen
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
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
          onClick={() => setSelectedAssetId(null)}
        >
          {assets.map((asset) => (
            <div
              key={asset.id}
              draggable
              onDragStart={(e) => handleDragStart(e, asset)}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedAssetId(asset.id);
              }}
              className={`relative group bg-app-surface border ${selectedAssetId === asset.id ? "border-app-accent" : "border-app-border"} rounded overflow-hidden aspect-square flex items-center justify-center cursor-grab active:cursor-grabbing`}
            >
              <img
                src={asset.url}
                alt={asset.name}
                className="max-w-full max-h-full object-contain pointer-events-none"
              />
              {selectedAssetId === asset.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (
                      window.confirm(
                        "Are you sure you want to delete this asset?",
                      )
                    ) {
                      onDeleteAsset(asset.id);
                      setSelectedAssetId(null);
                    }
                  }}
                  className="absolute top-1 right-1 bg-red-900/80 hover:bg-red-800 text-white p-1 rounded-full z-10"
                >
                  <X size={12} />
                </button>
              )}
              <div
                className={`absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-center items-center gap-1 ${selectedAssetId === asset.id ? "pointer-events-none" : ""}`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddToCanvas(asset);
                  }}
                  className="text-[10px] bg-app-main hover:bg-white text-app-base px-2 py-1 rounded pointer-events-auto"
                >
                  Use
                </button>
              </div>
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-[9px] text-white px-1 truncate pointer-events-none">
                {asset.name}
              </div>
            </div>
          ))}
          {assets.length === 0 && (
            <div className="col-span-full text-xs text-app-muted text-center p-4">
              Upload images to use them on canvas.
            </div>
          )}
        </div>
      </div>
    </CollapsiblePanel>
  );
}
