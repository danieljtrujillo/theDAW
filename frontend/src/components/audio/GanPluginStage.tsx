/**
 * GanPluginStage — renders a loaded .gan web-plugin in the MIX Effect Stage
 * footprint (the same spot Studio Modules land). The plugin's UI is served from
 * the backend runtime (/api/plugin/<id>/runtime/index.html) and iframed here;
 * its control postMessages bubble to the app (a host can route them later). The
 * Owl is a separate native case; this is the generic loader surface.
 */
import { Blocks } from 'lucide-react';

export function GanPluginStage({ url, name }: { url: string | null; name: string | null }) {
  if (!url) {
    return (
      <div className="h-full w-full min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4">
        <Blocks className="w-6 h-6 text-zinc-700" />
        <span className="text-[11px] text-zinc-500">Open a .gan plugin to load it here.</span>
        <span className="text-[9px] font-mono text-zinc-600">portable GANTASMO web-plugins</span>
      </div>
    );
  }
  return (
    <div className="h-full w-full min-h-0 overflow-hidden bg-[#07080c]">
      <iframe
        key={url}
        src={url}
        title={name ?? 'GAN plugin'}
        className="w-full h-full border-0 block"
      />
    </div>
  );
}
