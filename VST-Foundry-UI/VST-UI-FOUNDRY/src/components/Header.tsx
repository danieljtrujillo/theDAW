import React from 'react';
import { Code, Image as ImageIcon, Trash2, Undo2, Redo2, Save, FolderOpen, Download, Play, Pencil, Settings, Archive, Scissors, Package } from 'lucide-react';
import { CanvasState } from '../types';
import BrandTitle from './brand-title/BrandTitle';

interface HeaderProps {
  canvasState: CanvasState;
  onUpdateCanvas: (updates: Partial<CanvasState>) => void;
  onExport: () => void;
  onClear: () => void;
  hasElements: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSaveProject?: () => void;
  onOpenProjects?: () => void;
  onDownloadProject?: () => void;
  onExportPackage?: () => void;
  onOpenGan?: () => void;
  onOpenSettings: () => void;
  onOpenExtractor: () => void;
}

export default function Header({ 
  canvasState, 
  onUpdateCanvas, 
  onExport, 
  onClear, 
  hasElements,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSaveProject,
  onOpenProjects,
  onDownloadProject,
  onExportPackage,
  onOpenGan,
  onOpenSettings,
  onOpenExtractor
}: HeaderProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const availableWidth = window.innerWidth - 650;
          const availableHeight = window.innerHeight - 100;
          const scaleX = availableWidth / img.width;
          const scaleY = availableHeight / img.height;
          let newScale = Math.min(scaleX, scaleY);
          if (newScale > 1) newScale = 1;
          if (newScale < 0.1) newScale = 0.1;
          
          onUpdateCanvas({
            backgroundImage: event.target?.result as string,
            width: img.width,
            height: img.height,
            scale: newScale,
            panX: 0,
            panY: 0
          });
        };
        img.src = event.target?.result as string;
      };
      reader.onerror = () => {
        console.error('Failed to read background image', reader.error);
        alert('Failed to read the selected image file. Please try again.');
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <header className="min-h-14 border-b border-app-border bg-app-base flex items-center gap-x-3 py-1.5 px-4 z-10 shrink-0 shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-3 shrink-0">
        <BrandTitle mainWord="VST FOUNDRY" pixelWord="GANTASMO" byline="StarskreamEXE" />
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 min-w-0 overflow-x-auto [scrollbar-width:thin] [&>*]:shrink-0">
        <div className="flex items-center gap-2 bg-app-base p-1.5 rounded-lg border border-app-border neu-panel-inset">
          <label className="flex items-center gap-1.5 text-xs text-app-main cursor-pointer hover:text-white transition-colors">
            <input 
              type="checkbox" 
              checked={canvasState.showRulers !== false} 
              onChange={e => onUpdateCanvas({ showRulers: e.target.checked })}
              className="rounded border-app-border bg-app-base text-app-main focus:ring-app-main focus:ring-offset-app-surface"
            />
            Show Rulers
          </label>
          <div className="w-px h-3 bg-app-border" />
          <label className="flex items-center gap-1.5 text-xs text-app-main cursor-pointer hover:text-white transition-colors">
            <input 
              type="checkbox" 
              checked={canvasState.showGrid || false} 
              onChange={e => onUpdateCanvas({ showGrid: e.target.checked })}
              className="rounded border-app-border bg-app-base text-app-main focus:ring-app-main focus:ring-offset-app-surface"
            />
            Grid Overlay
          </label>
          <div className="w-px h-3 bg-app-border" />
          <label className="flex items-center gap-1.5 text-xs text-app-main cursor-pointer hover:text-white transition-colors">
            <input 
              type="checkbox" 
              checked={canvasState.snapToGrid !== false} 
              onChange={e => onUpdateCanvas({ snapToGrid: e.target.checked })}
              className="rounded border-app-border bg-app-base text-app-main focus:ring-app-main focus:ring-offset-app-surface"
            />
            Snap to Grid
          </label>
          <div className="w-px h-3 bg-app-border" />
          <div className="flex items-center gap-1">
            <span className="text-xs text-app-muted">Size:</span>
            <input 
              type="number" 
              value={canvasState.gridSize || 10} 
              onChange={e => onUpdateCanvas({ gridSize: Math.max(2, parseInt(e.target.value) || 10) })}
              className="w-12 bg-app-surface border border-app-border rounded px-1 py-0.5 text-xs text-app-main text-center outline-none focus:border-app-main"
              title="Grid Size"
            />
          </div>
        </div>

        <div className="flex items-center bg-app-base border border-app-border rounded-lg p-1 neu-panel-inset">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="p-1.5 text-app-main hover:text-white hover:bg-app-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-app-border mx-1" />
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="p-1.5 text-app-main hover:text-white hover:bg-app-surface disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>

        <input 
          type="file" 
          ref={fileInputRef} 
          accept="image/*" 
          className="hidden" 
          onChange={handleImageUpload}
        />
        
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          title="Upload a background image for your UI layout"
        >
          <ImageIcon className="w-4 h-4 shrink-0" />
          <span className="hidden lg:inline">{canvasState.backgroundImage ? 'Change Background' : 'Upload Background'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenExtractor}
          className="flex items-center justify-center p-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          aria-label="Extract components from background"
          title="Extract Components"
        >
          <Scissors className="w-4 h-4 shrink-0" />
        </button>

        {hasElements && (
          <button
            onClick={onClear}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-400 btn-3d rounded-lg"
            title="Clear all elements from canvas"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}

        <div className="w-px h-6 bg-app-border mx-1" />

        <button
          onClick={() => onUpdateCanvas({ isPreviewMode: !canvasState.isPreviewMode })}
          className={`flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-lg transition-colors shadow-lg ${canvasState.isPreviewMode ? 'bg-app-accent text-white' : 'btn-3d text-app-main'}`}
          title="Toggle between editing and interacting with your UI"
        >
          {canvasState.isPreviewMode ? <Pencil className="w-4 h-4 shrink-0" /> : <Play className="w-4 h-4 shrink-0" />}
          <span className="hidden lg:inline">{canvasState.isPreviewMode ? 'Edit Mode' : 'Demo Mode'}</span>
        </button>

        <button
          onClick={onOpenProjects}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          title="Open Project Library"
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        {onOpenGan && (
          <button
            onClick={onOpenGan}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
            aria-label="Open a .gan plugin to edit"
            title="Open a .gan plugin to edit"
          >
            <Package className="w-4 h-4" />
            <span className="hidden lg:inline">Open .gan</span>
          </button>
        )}

        <button
          onClick={onSaveProject}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          title="Save Project to Local Storage"
        >
          <Save className="w-4 h-4" />
        </button>

        <button
          onClick={onDownloadProject}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          title="Download Project JSON"
        >
          <Download className="w-4 h-4" />
        </button>

        <button
          onClick={onExportPackage}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-app-main btn-3d rounded-lg"
          title="Export Full Package (ZIP)"
        >
          <Archive className="w-4 h-4" />
          <span className="hidden lg:inline">Package</span>
        </button>

        <button
          onClick={onExport}
          className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium text-white btn-3d rounded-lg shadow-lg"
          title="Export Layout to React/TSX or JSON"
        >
          <Code className="w-4 h-4 shrink-0" />
          <span className="hidden lg:inline">Export Code</span>
        </button>

        <button
          onClick={onOpenSettings}
          className="flex items-center justify-center p-1.5 text-sm font-medium text-app-main btn-3d rounded-lg ml-2"
          title="Settings (Theme, Canvas Size)"
        >
          <Settings className="w-5 h-5" />
        </button>

      </div>
    </header>
  );
}
