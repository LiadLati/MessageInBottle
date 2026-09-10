import type { ChartResponse, ChartPoint, SentBottleSummaryDto } from '@mib/shared';

interface Props {
  chart: ChartResponse;
  bottles: SentBottleSummaryDto[];
  selectedId?: string | null | undefined;
  onSelect?: ((id: string) => void) | undefined;
  highlightRoute?: ChartPoint[] | null | undefined;
  originShoreId?: string | null | undefined;
  destinationShoreId?: string | null | undefined;
}

// Private ocean placeholder: an abstract, border-free sea chart with fictional shore names
// (spec §6.2). Final illustration and animation arrive with the design phase.
export function SeaChart({
  chart,
  bottles,
  selectedId,
  onSelect,
  highlightRoute,
  originShoreId,
  destinationShoreId,
}: Props) {
  const { width, height } = chart.bounds;
  const nodeById = new Map(chart.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="sea-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Private sea chart showing your bottles and their routes"
    >
      <rect x={0} y={0} width={width} height={height} className="sea-water" />
      {chart.edges.map((e) => {
        const a = nodeById.get(e.from);
        const b = nodeById.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.from}-${e.to}`}
            x1={a.position.x}
            y1={a.position.y}
            x2={b.position.x}
            y2={b.position.y}
            className="sea-passage"
          />
        );
      })}
      {chart.nodes
        .filter((n) => n.kind === 'island')
        .map((n) => (
          <g key={n.id}>
            <circle cx={n.position.x} cy={n.position.y} r={16} className="island" />
            <text
              x={n.position.x}
              y={n.position.y + 32}
              className="chart-label"
              textAnchor="middle"
            >
              island
            </text>
          </g>
        ))}
      {highlightRoute && highlightRoute.length > 1 ? (
        <polyline
          points={highlightRoute.map((p) => `${p.x},${p.y}`).join(' ')}
          className="route-planned"
        />
      ) : null}
      {bottles.map((b) => {
        const pts = b.route.points;
        const done = b.position.progress;
        const trail = trailPoints(pts, done);
        const selected = b.id === selectedId;
        return (
          <g
            key={b.id}
            className={selected ? 'bottle-group selected' : 'bottle-group'}
            onClick={() => onSelect?.(b.id)}
          >
            <polyline
              points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
              className="route-planned"
            />
            {trail.length > 1 ? (
              <polyline
                points={trail.map((p) => `${p.x},${p.y}`).join(' ')}
                className="route-done"
              />
            ) : null}
            <BottleMarker state={b.state} point={b.position.point} selected={selected} />
          </g>
        );
      })}
      {chart.shores.map((s) => {
        const isOrigin = s.id === originShoreId;
        const isDest = s.id === destinationShoreId;
        return (
          <g key={s.id}>
            <circle
              cx={s.position.x}
              cy={s.position.y}
              r={12}
              className={`shore${isOrigin ? ' shore-origin' : ''}${isDest ? ' shore-dest' : ''}`}
            />
            <text
              x={s.position.x}
              y={s.position.y - 18}
              className="chart-label"
              textAnchor="middle"
            >
              {s.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function BottleMarker({
  state,
  point,
  selected,
}: {
  state: SentBottleSummaryDto['state'];
  point: ChartPoint;
  selected: boolean;
}) {
  const r = selected ? 11 : 8;
  switch (state) {
    case 'at_sea':
      return <circle cx={point.x} cy={point.y} r={r} className="bottle bottle-at-sea" />;
    case 'delivered':
    case 'opened':
      return <circle cx={point.x} cy={point.y} r={r} className="bottle bottle-delivered" />;
    case 'lost':
    case 'discarded':
    case 'cancelled':
      return (
        <g className="bottle bottle-terminal">
          <line x1={point.x - r} y1={point.y - r} x2={point.x + r} y2={point.y + r} />
          <line x1={point.x - r} y1={point.y + r} x2={point.x + r} y2={point.y - r} />
        </g>
      );
    default:
      return (
        <rect
          x={point.x - r}
          y={point.y - r}
          width={r * 2}
          height={r * 2}
          className="bottle bottle-stranded"
        />
      );
  }
}

function trailPoints(points: ChartPoint[], progress: number): ChartPoint[] {
  if (points.length < 2 || progress <= 0) return [];
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    lengths.push(len);
    total += len;
  }
  let remaining = progress * total;
  const out: ChartPoint[] = [points[0]!];
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    const a = points[i]!;
    const b = points[i + 1]!;
    if (remaining >= len) {
      out.push(b);
      remaining -= len;
    } else {
      const t = len === 0 ? 0 : remaining / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      break;
    }
  }
  return out;
}
