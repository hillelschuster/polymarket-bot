// Hand-rolled SVG line chart (no chart dependency). SPEC §11.
export function LineChart({
  points,
  width = 320,
  height = 80,
}: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length === 0) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = height - ((p - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="overflow-visible">
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="#3fb950"
        strokeWidth={1.5}
      />
    </svg>
  );
}
