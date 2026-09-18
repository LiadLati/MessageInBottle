import { Suspense, lazy, type ComponentProps } from 'react';
import type { OceanMap as OceanMapImpl } from './OceanMap.js';
import type { ShoreScene as ShoreSceneImpl } from './ShoreScene.js';
import type { ReleaseSequence as ReleaseSequenceImpl } from './ReleaseSequence.js';
import type { SeaViewer as SeaViewerImpl } from './SeaViewer.js';

// The map SDK and the 3D engine are the two heavy chunks; they load with the first screen that
// needs a world layer, never with sign-in.
const OceanMapChunk = lazy(() => import('./OceanMap.js').then((m) => ({ default: m.OceanMap })));
const ShoreSceneChunk = lazy(() =>
  import('./ShoreScene.js').then((m) => ({ default: m.ShoreScene })),
);
const ReleaseSequenceChunk = lazy(() =>
  import('./ReleaseSequence.js').then((m) => ({ default: m.ReleaseSequence })),
);
// The sea viewer (and the scene it mounts) load only when "View at sea" is first pressed.
const SeaViewerChunk = lazy(() => import('./SeaViewer.js').then((m) => ({ default: m.SeaViewer })));

export function OceanMap(props: ComponentProps<typeof OceanMapImpl>) {
  return (
    <Suspense fallback={<div className="ocean-map" />}>
      <OceanMapChunk {...props} />
    </Suspense>
  );
}

export function ShoreScene(props: ComponentProps<typeof ShoreSceneImpl>) {
  return (
    <Suspense fallback={<div className={`shore-scene ${props.mode}`} />}>
      <ShoreSceneChunk {...props} />
    </Suspense>
  );
}

export function ReleaseSequence(props: ComponentProps<typeof ReleaseSequenceImpl>) {
  return (
    <Suspense fallback={<div className="world-screen" />}>
      <ReleaseSequenceChunk {...props} />
    </Suspense>
  );
}

export function SeaViewer(props: ComponentProps<typeof SeaViewerImpl>) {
  return (
    <Suspense fallback={null}>
      <SeaViewerChunk {...props} />
    </Suspense>
  );
}
