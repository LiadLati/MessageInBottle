import { Suspense, lazy, useState, type ComponentProps, type ComponentType } from 'react';
import { ErrorBoundary, PartUnavailable } from './ErrorBoundary.js';
import type { OceanMap as OceanMapImpl } from './OceanMap.js';
import type { ShoreScene as ShoreSceneImpl } from './ShoreScene.js';
import type { ReleaseSequence as ReleaseSequenceImpl } from './ReleaseSequence.js';
import type { SeaViewer as SeaViewerImpl } from './SeaViewer.js';

// The map SDK and the 3D engine are the two heavy chunks; they load with the first screen that
// needs a world layer, never with sign-in.
//
// React.lazy remembers a failed import forever, so "Try again" after a dropped connection
// would fail at once. Each chunk can therefore be reset to a fresh lazy component (audit
// FE-001), and a failure is contained by an error boundary instead of blanking the app.
function chunk<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let current = lazy(load);
  return {
    get: () => current,
    reset: () => {
      current = lazy(load);
    },
  };
}

const OceanMapChunk = chunk<ComponentProps<typeof OceanMapImpl>>(() =>
  import('./OceanMap.js').then((m) => ({ default: m.OceanMap })),
);
const ShoreSceneChunk = chunk<ComponentProps<typeof ShoreSceneImpl>>(() =>
  import('./ShoreScene.js').then((m) => ({ default: m.ShoreScene })),
);
const ReleaseSequenceChunk = chunk<ComponentProps<typeof ReleaseSequenceImpl>>(() =>
  import('./ReleaseSequence.js').then((m) => ({ default: m.ReleaseSequence })),
);
// The sea viewer (and the scene it mounts) load only when "View at sea" is first pressed.
const SeaViewerChunk = chunk<ComponentProps<typeof SeaViewerImpl>>(() =>
  import('./SeaViewer.js').then((m) => ({ default: m.SeaViewer })),
);

function Contained<P extends object>({
  source,
  what,
  fallback,
  props,
}: {
  source: ReturnType<typeof chunk<P>>;
  what: string;
  fallback: React.ReactNode;
  props: P;
}) {
  // The module-level lazy component, replaced only by an explicit retry below.
  const [Loaded, setLoaded] = useState(() => source.get());
  return (
    <ErrorBoundary
      fallback={(retry) => (
        <PartUnavailable
          what={what}
          retry={() => {
            source.reset();
            setLoaded(() => source.get());
            retry();
          }}
        />
      )}
    >
      <Suspense fallback={fallback}>
        <Loaded {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

export function OceanMap(props: ComponentProps<typeof OceanMapImpl>) {
  return (
    <Contained
      source={OceanMapChunk}
      what="map"
      fallback={<div className="ocean-map" />}
      props={props}
    />
  );
}

export function ShoreScene(props: ComponentProps<typeof ShoreSceneImpl>) {
  return (
    <Contained
      source={ShoreSceneChunk}
      what="shore scene"
      fallback={<div className={`shore-scene ${props.mode}`} />}
      props={props}
    />
  );
}

export function ReleaseSequence(props: ComponentProps<typeof ReleaseSequenceImpl>) {
  return (
    <Contained
      source={ReleaseSequenceChunk}
      what="release sequence"
      fallback={<div className="world-screen" />}
      props={props}
    />
  );
}

export function SeaViewer(props: ComponentProps<typeof SeaViewerImpl>) {
  return <Contained source={SeaViewerChunk} what="sea view" fallback={null} props={props} />;
}
