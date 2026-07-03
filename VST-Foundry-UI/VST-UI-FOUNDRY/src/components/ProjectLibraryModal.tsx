import { X, Trash2, Calendar, FileJson, FolderOpen } from 'lucide-react';
import { UIElement, CanvasState, Asset, Texture } from '../types';

export interface SavedProject {
  id: string;
  name: string;
  createdAt: number;
  elements: UIElement[];
  canvasState: CanvasState;
  assets: Asset[];
  textures?: Texture[];
}

interface ProjectLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: SavedProject[];
  onLoadProject: (project: SavedProject) => void;
  onDeleteProject: (id: string) => void;
}

export default function ProjectLibraryModal({ 
  isOpen, 
  onClose, 
  projects, 
  onLoadProject,
  onDeleteProject 
}: ProjectLibraryModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-app-base border border-app-border rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between p-6 border-b border-app-border shrink-0">
          <div>
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              <FileJson className="w-5 h-5 text-app-main" />
              Project Library
            </h2>
            <p className="text-sm text-app-muted mt-1">Load or manage your saved UI layouts</p>
          </div>
          <button 
            onClick={onClose}
            className="text-app-muted hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 bg-black/20">
          {projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-app-muted">
              <FolderOpen className="w-12 h-12 mb-4 opacity-20" />
              <p>No saved projects found.</p>
              <p className="text-sm mt-1">Save your current work from the top bar to see it here.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map((proj) => (
                <div key={proj.id} className="bg-app-surface border border-app-border rounded-lg p-4 hover:border-app-main/50 transition-colors group">
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="text-lg font-medium text-app-main truncate pr-4" title={proj.name}>
                      {proj.name}
                    </h3>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteProject(proj.id); }}
                      className="text-app-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                      title="Delete Project"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center text-xs text-app-muted">
                      <Calendar className="w-3.5 h-3.5 mr-1.5" />
                      {new Date(proj.createdAt).toLocaleString()}
                    </div>
                    <div className="text-xs text-app-muted flex gap-3">
                      <span>Elements: {proj.elements.length}</span>
                      <span>Assets: {proj.assets.length}</span>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={() => onLoadProject(proj)}
                      className="px-4 py-2 btn-3d text-white text-sm font-medium rounded-lg w-full"
                    >
                      Load Project
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
