import React from 'react';
import { X, Copy, Check, Download } from 'lucide-react';
import { UIElement, CanvasState, Asset, Texture, CustomModule } from '../types';
import { buildVst3Manifest, exportVst3Bundle } from '../lib/vst3Export';
import { exportGan } from '../lib/ganExport';
import { buildGanManifest } from '../lib/ganManifest';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  elements: UIElement[];
  canvasState: CanvasState;
  assets: Asset[];
  textures: Texture[];
  customModules: CustomModule[];
}

type ExportMode = 'react' | 'vst3' | 'gan';

const DEFAULT_PLUGIN_NAME = 'Foundry Plugin';

export default function ExportModal({
  isOpen,
  onClose,
  elements,
  canvasState,
  assets,
  textures,
  customModules,
}: ExportModalProps) {
  const [copied, setCopied] = React.useState(false);
  const [mode, setMode] = React.useState<ExportMode>('react');
  const [pluginName, setPluginName] = React.useState(DEFAULT_PLUGIN_NAME);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);

  // Param summary for the VST3 tab: N params derived from M controls. Built from
  // the same manifest that the export writes, so the counts never drift.
  const paramSummary = React.useMemo(() => {
    const manifest = buildVst3Manifest(
      elements,
      canvasState,
      pluginName.trim() || DEFAULT_PLUGIN_NAME,
    );
    const controlCount = new Set(manifest.params.map((p) => p.elementId)).size;
    return { paramCount: manifest.params.length, controlCount };
  }, [elements, canvasState, pluginName]);

  // Control count for the .gan tab, from the same manifest the export writes.
  const ganSummary = React.useMemo(() => {
    const manifest = buildGanManifest(
      elements,
      canvasState,
      pluginName.trim() || DEFAULT_PLUGIN_NAME,
    );
    return { controlCount: manifest.controls.length };
  }, [elements, canvasState, pluginName]);

  if (!isOpen) return null;

  const generateCode = () => {
    const renderEl = (el: UIElement): string => {
      const style = `{{ position: 'absolute', left: ${el.x}, top: ${el.y}, width: ${el.width}, height: ${el.height} }}`;

      switch (el.type) {
        case 'Knob':
          return `        <Knob id="${el.name}" style=${style} />`;
        case 'Slider':
          return `        <Slider id="${el.name}" style=${style} />`;
        case 'Button':
          return `        <Button id="${el.name}" style=${style}>${el.label || el.name}</Button>`;
        case 'Label':
          return `        <Label id="${el.name}" style=${style}>${el.label || 'Label'}</Label>`;
        case 'Toggle':
          return `        <Toggle id="${el.name}" style=${style} />`;
        case 'Select':
          return `        <Select id="${el.name}" style=${style} />`;
        case 'Waveform':
          return `        <Waveform id="${el.name}" style=${style} variant="${el.variant || 'Modern'}" />`;
        case 'Meter':
          return `        <Meter id="${el.name}" style=${style} variant="${el.variant || 'VU Meter'}" />`;
        case 'XYPad':
          return `        <XYPad id="${el.name}" style=${style} />`;
        case 'Spatial3D':
          return `        <Spatial3D id="${el.name}" style=${style} />`;
        case 'Image':
          return `        <img id="${el.name}" src="/path-to-your-asset-${el.assetId || el.name}.png" alt="${el.label || el.name}" style=${style} />`;
        case 'Group': {
          const childCode = elements
            .filter(child => child.groupId === el.id)
            .map(renderEl)
            .join('\n');
          return `        <div id="${el.name}" style=${style}>\n${childCode}\n        </div>`;
        }
        case 'CustomCode':
          return `        <div id="${el.name}" style=${style} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(el.customCode || '')} }} />`;
        default:
          return `        <div id="${el.name}" style=${style} />`;
      }
    };

    const elementComponents = elements
      .filter(el => !el.groupId)
      .map(renderEl)
      .join('\n');

    return `import React from 'react';
// Import your UI components here
import { Knob, Slider, Button, Label, Toggle, Select, Waveform, Meter, XYPad, Spatial3D } from './components';

export default function UIModule() {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        width: ${canvasState.width},
        height: ${canvasState.height},
        backgroundImage: 'url(/path-to-your-background.png)',
        backgroundSize: 'contain'
      }}
    >
${elementComponents}
    </div>
  );
}`;
  };

  const code = generateCode();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code to clipboard:', err);
    }
  };

  const handleExportVst3 = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportVst3Bundle(
        elements,
        canvasState,
        assets,
        textures,
        pluginName.trim() || DEFAULT_PLUGIN_NAME,
      );
    } catch (err) {
      console.error('Failed to export VST3 bundle:', err);
      setExportError('Failed to create the VST3 bundle. See console for details.');
    } finally {
      setExporting(false);
    }
  };

  const handleExportGan = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await exportGan(
        elements,
        canvasState,
        assets,
        textures,
        customModules,
        pluginName.trim() || DEFAULT_PLUGIN_NAME,
      );
    } catch (err) {
      console.error('Failed to export .gan:', err);
      setExportError('Failed to create the .gan plugin. See console for details.');
    } finally {
      setExporting(false);
    }
  };

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
      active
        ? 'bg-app-surface text-white'
        : 'text-app-muted hover:text-white'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-app-base border border-app-border rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-full overflow-hidden">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-medium text-white">Export</h2>
            <div className="flex items-center gap-1 p-1 bg-app-base border border-app-border rounded-lg">
              <button
                type="button"
                onClick={() => setMode('react')}
                className={tabClass(mode === 'react')}
              >
                React Code
              </button>
              <button
                type="button"
                onClick={() => setMode('vst3')}
                className={tabClass(mode === 'vst3')}
              >
                VST3 Bundle
              </button>
              <button
                type="button"
                onClick={() => setMode('gan')}
                className={tabClass(mode === 'gan')}
              >
                .gan Plugin
              </button>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-app-muted hover:text-white rounded-lg hover:bg-app-surface transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {mode === 'react' && (
          <>
            <div className="p-6 overflow-auto bg-[#0d1117]">
              <pre className="text-sm font-mono text-app-main">
                <code>{code}</code>
              </pre>
            </div>

            <div className="px-6 py-4 border-t border-app-border bg-app-base flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-app-main hover:text-white transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 btn-3d text-white text-sm font-medium rounded-lg shadow-sm"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied!' : 'Copy Code'}
              </button>
            </div>
          </>
        )}

        {mode === 'vst3' && (
          <>
            <div className="p-6 overflow-auto flex flex-col gap-5">
              <p className="text-sm text-app-muted leading-relaxed">
                Export a VST3 data bundle: a{' '}
                <span className="text-app-main">manifest.json</span> with
                host-visible parameters plus a self-contained interactive UI
                (<span className="text-app-main">ui/index.html</span> +{' '}
                <span className="text-app-main">ui/params.js</span>). Drop it into
                the prebuilt Foundry shell to produce a loadable plugin.
              </p>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="vst3-plugin-name"
                  className="text-sm font-medium text-app-main"
                >
                  Plugin name
                </label>
                <input
                  id="vst3-plugin-name"
                  name="vst3-plugin-name"
                  type="text"
                  value={pluginName}
                  onChange={(e) => setPluginName(e.target.value)}
                  placeholder={DEFAULT_PLUGIN_NAME}
                  className="w-full px-3 py-2 bg-app-base border border-app-border rounded-lg text-sm text-white placeholder:text-app-muted focus:outline-none focus:border-app-accent"
                />
              </div>

              <div className="text-sm text-app-muted">
                <span className="text-app-main font-medium">
                  {paramSummary.paramCount}
                </span>{' '}
                {paramSummary.paramCount === 1 ? 'parameter' : 'parameters'} from{' '}
                <span className="text-app-main font-medium">
                  {paramSummary.controlCount}
                </span>{' '}
                {paramSummary.controlCount === 1 ? 'control' : 'controls'}.
              </div>

              {exportError && (
                <div className="text-sm text-red-400">{exportError}</div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-app-border bg-app-base flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-app-main hover:text-white transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleExportVst3}
                disabled={exporting}
                className="flex items-center gap-2 px-4 py-2 btn-3d text-white text-sm font-medium rounded-lg shadow-sm disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {exporting ? 'Exporting…' : 'Export .zip'}
              </button>
            </div>
          </>
        )}

        {mode === 'gan' && (
          <>
            <div className="p-6 overflow-auto flex flex-col gap-5">
              <p className="text-sm text-app-muted leading-relaxed">
                Export a{' '}
                <span className="text-app-main">.gan</span> plugin — theDAW's
                native plugin/VST filetype. It bundles a self-contained
                interactive UI plus a manifest, and embeds this project so you
                can reopen the <span className="text-app-main">.gan</span> and
                keep editing.
              </p>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="gan-plugin-name"
                  className="text-sm font-medium text-app-main"
                >
                  Plugin name
                </label>
                <input
                  id="gan-plugin-name"
                  name="gan-plugin-name"
                  type="text"
                  value={pluginName}
                  onChange={(e) => setPluginName(e.target.value)}
                  placeholder={DEFAULT_PLUGIN_NAME}
                  className="w-full px-3 py-2 bg-app-base border border-app-border rounded-lg text-sm text-white placeholder:text-app-muted focus:outline-none focus:border-app-accent"
                />
              </div>

              <div className="text-sm text-app-muted">
                <span className="text-app-main font-medium">
                  {ganSummary.controlCount}
                </span>{' '}
                {ganSummary.controlCount === 1 ? 'control' : 'controls'} emitted
                to theDAW.
              </div>

              {exportError && (
                <div className="text-sm text-red-400">{exportError}</div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-app-border bg-app-base flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-app-main hover:text-white transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleExportGan}
                disabled={exporting}
                className="flex items-center gap-2 px-4 py-2 btn-3d text-white text-sm font-medium rounded-lg shadow-sm disabled:opacity-60"
              >
                <Download className="w-4 h-4" />
                {exporting ? 'Exporting…' : 'Export .gan'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
