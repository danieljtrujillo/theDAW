import React, { Suspense, lazy, type ComponentProps } from 'react';

/* Lazy boundary for the cymatics/orb VisualizerPanel.
 *
 * CymaticsVisualizer statically imports the whole `three` engine (+ EXR loader,
 * EffectComposer, UnrealBloomPass). Importing it eagerly pulled ~all of three
 * into the main bundle. Loading it through React.lazy() splits three into its
 * own chunk that streams in AFTER the host panel (MAKE / MIX) has painted, so
 * the tab is interactive immediately and the WebGL engine arrives behind a
 * lightweight fallback. Drop-in: same name + props as the original. */
const Inner = lazy(() =>
  import('./CymaticsVisualizer').then((m) => ({ default: m.VisualizerPanel })),
);

export function VisualizerPanel(props: ComponentProps<typeof Inner>) {
  return (
    <Suspense
      fallback={
        <div className={`grid place-items-center ${props.className ?? ''}`}>
          <span className="text-[10px] font-mono text-zinc-600 animate-pulse">loading visualizer…</span>
        </div>
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
