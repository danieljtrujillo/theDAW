import React from 'react';
import { AlertCircle, AlertTriangle, FolderInput, Layers, Loader2, PackagePlus, Scissors, SlidersHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useDawImportStore } from '../state/dawImportStore';
import { useProjectStore } from '../state/projectStore';
import { DAW_LABELS } from '../lib/dawImportClient';
import { dawProjectToTasmo, type RecentItem } from '../lib/projectClient';
import { capturePerformRouting } from '../state/performRouting';
import { SESSION_IMPORT_FILTER } from '../lib/fileFilters';
import { PathInput } from '../components/ui/PathInput';
import { DawSessionGrid } from '../components/session/DawSessionGrid';
import { PerformRoutingPanel } from '../components/session/PerformRoutingPanel';
import { importDawProjectToEditor } from '../lib/dawProjectToEditor';

export const SessionView: React.FC = () => {
  const { sourcePath, detected, project, hint, busy, error } = useDawImportStore(
    useShallow((s) => ({
      sourcePath: s.sourcePath,
      detected: s.detected,
      project: s.project,
      hint: s.hint,
      busy: s.busy,
      error: s.error,
    })),
  );
  const setSourcePath = useDawImportStore((s) => s.setSourcePath);
  const detectAndImport = useDawImportStore((s) => s.detectAndImport);
  const loadTasmoAsSession = useDawImportStore((s) => s.loadTasmoAsSession);
  const openProject = useProjectStore((s) => s.open);
  const recent = useProjectStore((s) => s.recent);
  const refreshRecent = useProjectStore((s) => s.refreshRecent);
  const [timelineBusy, setTimelineBusy] = React.useState(false);
  const [showRouting, setShowRouting] = React.useState(false);
  const [recentOpen, setRecentOpen] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const blurCloseTimer = React.useRef<number | null>(null);
  const recentVisible = recentOpen && recent.length > 0;

  // A refresh can shrink the list while the dropdown is open; keep the active
  // option (and aria-activedescendant) pointing at a rendered row.
  React.useEffect(() => {
    setActiveIdx((i) => Math.min(i, recent.length - 1));
  }, [recent.length]);

  // A .tasmo opens directly in the grid; any DAW project file goes through detect+import.
  const importSource = () => {
    if (sourcePath.trim().toLowerCase().endsWith('.tasmo')) void loadTasmoAsSession();
    else void detectAndImport();
  };

  const openRecent = () => {
    // A pending blur-close from a quick blur/refocus would otherwise close the
    // dropdown right after this open.
    if (blurCloseTimer.current !== null) {
      window.clearTimeout(blurCloseTimer.current);
      blurCloseTimer.current = null;
    }
    setRecentOpen(true);
    setActiveIdx(-1);
    void refreshRecent();
  };

  const closeRecent = () => {
    setRecentOpen(false);
    setActiveIdx(-1);
  };

  // Delayed so an option's onClick lands before the dropdown unmounts.
  const scheduleCloseRecent = () => {
    if (blurCloseTimer.current !== null) window.clearTimeout(blurCloseTimer.current);
    blurCloseTimer.current = window.setTimeout(() => {
      blurCloseTimer.current = null;
      closeRecent();
    }, 150);
  };

  // Mirrors ProjectModal's one-click UX: picking a recent entry imports it
  // immediately. setSourcePath commits synchronously, so detectAndImport reads
  // the freshly set path from the store.
  const pickRecent = (r: RecentItem) => {
    // Match the Import button's guard so a pick cannot start a second import
    // while one is in flight.
    if (busy) return;
    setSourcePath(r.path);
    closeRecent();
    if (r.path.toLowerCase().endsWith('.tasmo')) void loadTasmoAsSession(r.path);
    else void detectAndImport();
  };

  const onPathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!recentOpen) {
        setRecentOpen(true);
        void refreshRecent();
      }
      setActiveIdx((i) => Math.min(i + 1, recent.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Escape') {
      closeRecent();
    } else if (e.key === 'Enter' && recentVisible && activeIdx >= 0 && recent[activeIdx]) {
      e.preventDefault();
      pickRecent(recent[activeIdx]);
    }
  };

  const saveAsTasmo = () => {
    if (!project) return;
    openProject('save', { ...dawProjectToTasmo(project), perform_routing: capturePerformRouting() });
  };

  const editInTimeline = async () => {
    if (!project) return;
    setTimelineBusy(true);
    try {
      await importDawProjectToEditor(project);
    } finally {
      setTimelineBusy(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0b0b10]">
      <div className="shrink-0 border-b border-white/10 bg-[#111118] px-3 py-2 flex items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-widest text-zinc-100">
              Perform
            </div>
            <div className="text-[8px] font-mono text-zinc-500 truncate">
              {project ? `${project.name} · ${project.tempo} BPM` : 'No project loaded'}
            </div>
          </div>
        </div>
        <div className="relative flex-1 min-w-0 flex items-center gap-2">
          <PathInput
            id="session-import-path"
            name="session_import_path"
            label="Project"
            kind="file"
            inline
            fileFilter={SESSION_IMPORT_FILTER}
            value={sourcePath}
            onChange={setSourcePath}
            onEnter={importSource}
            onFocus={openRecent}
            onBlur={scheduleCloseRecent}
            onKeyDown={onPathKeyDown}
            role="combobox"
            ariaExpanded={recentVisible}
            ariaControls={recentVisible ? 'session-recent-listbox' : undefined}
            ariaAutocomplete="list"
            ariaActiveDescendant={activeIdx >= 0 ? `session-recent-opt-${activeIdx}` : undefined}
            placeholder=".als / .tasmo"
            className="flex-1 min-w-0"
          />
          <button
            type="button"
            onClick={importSource}
            disabled={busy || !sourcePath.trim()}
            className="btn-primary h-7 px-2 inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderInput className="w-3 h-3" />}
            Import
          </button>
          {recentVisible && (
            <div
              id="session-recent-listbox"
              role="listbox"
              aria-label="Recent projects"
              className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 overflow-y-auto rounded border border-white/10 bg-black/90 shadow-xl"
            >
              {recent.map((r, i) => (
                <button
                  key={r.path}
                  type="button"
                  role="option"
                  id={`session-recent-opt-${i}`}
                  aria-selected={i === activeIdx}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickRecent(r)}
                  className={`w-full text-left px-2 py-1.5 border-b border-white/5 last:border-0 hover:bg-purple-500/15 ${
                    i === activeIdx ? 'bg-purple-500/10 text-purple-200' : 'text-zinc-200'
                  }`}
                >
                  <span className="block truncate text-[10px] font-mono">{r.name}</span>
                  <span className="block truncate text-[8px] text-zinc-500">{r.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {project && (
          <div className="ml-auto flex items-center gap-2 text-[8px] font-mono text-zinc-500">
            <span>{project.scenes.length} scenes</span>
            <span>{project.tracks.length} tracks</span>
            <button
              type="button"
              onClick={() => setShowRouting((v) => !v)}
              aria-pressed={showRouting}
              className={`h-7 px-2 inline-flex items-center gap-1 rounded border ${
                showRouting
                  ? 'border-fuchsia-400/40 text-fuchsia-100 bg-fuchsia-400/10'
                  : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
              }`}
              title="Assign the Sway (or any controller) to scene launch + mix modulation"
            >
              <SlidersHorizontal className="w-3 h-3" />
              Routing
            </button>
            <button
              type="button"
              onClick={saveAsTasmo}
              className="h-7 px-2 inline-flex items-center gap-1 rounded border border-white/10 text-zinc-300 hover:text-white hover:bg-white/5"
            >
              <PackagePlus className="w-3 h-3" />
              .tasmo
            </button>
            <button
              type="button"
              onClick={() => void editInTimeline()}
              disabled={timelineBusy}
              className="h-7 px-2 inline-flex items-center gap-1 rounded border border-emerald-400/30 text-emerald-100 hover:text-white hover:bg-emerald-400/10 disabled:opacity-45"
              title="Load this imported project into the editable timeline"
            >
              {timelineBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scissors className="w-3 h-3" />}
              Edit Timeline
            </button>
          </div>
        )}
      </div>

      {(error || detected || hint || project?.warnings.length) && (
        <div className="shrink-0 px-3 py-2 flex flex-col gap-1.5 bg-black/15 border-b border-white/5">
          {error && (
            <div className="flex items-center gap-2 text-[9px] font-mono text-red-200">
              <AlertCircle className="w-3 h-3 text-red-300 shrink-0" />
              {error}
            </div>
          )}
          {detected && (
            <div className="text-[9px] font-mono text-zinc-400">
              Detected <span className="text-sky-200">{DAW_LABELS[detected.daw] ?? detected.daw}</span>
            </div>
          )}
          {hint && (
            <div className="text-[9px] font-mono text-amber-100">
              {hint.limitation}
            </div>
          )}
          {project?.warnings.map((warning, index) => (
            <div key={index} className="flex items-start gap-1.5 text-[8px] font-mono text-amber-100">
              <AlertTriangle className="w-3 h-3 text-amber-300 shrink-0 mt-px" />
              {warning}
            </div>
          ))}
        </div>
      )}

      {project && showRouting && (
        <div className="shrink-0 max-h-72 overflow-hidden border-b border-white/5 bg-[#0d0d13]">
          <PerformRoutingPanel project={project} />
        </div>
      )}

      <div className="flex-1 min-h-0 p-2">
        {project ? (
          <DawSessionGrid project={project} fill />
        ) : (
          <div className="h-full rounded border border-dashed border-white/10 bg-black/15 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-center">
              <FolderInput className="w-7 h-7 text-zinc-600" />
              <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                No Project Loaded
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
