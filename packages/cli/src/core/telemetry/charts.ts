/**
 * Inline SVG charts.
 *
 * No charting library, and no dependency of any kind, for one reason that is a requirement rather
 * than a preference: the report has to open from a file on disk with no network. A CDN-hosted chart
 * library would make the dashboard fail exactly in the situation it exists for — a user offline, or
 * reviewing a report someone sent them.
 *
 * The charts are deliberately plain. Their job is to make a distribution legible, not to be
 * attractive, and every chart is accompanied by the numbers it is drawn from so a reader can check
 * it without trusting the picture.
 */

/** Escape text for inclusion in SVG/HTML. Descriptions reach here from catalog data, which is untrusted. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BarDatum {
  label: string;
  value: number;
  /** Drawn in a warning colour, for the bar that represents harm rather than benefit. */
  warn?: boolean;
}

/**
 * Horizontal bar chart.
 *
 * Horizontal rather than vertical because the labels are capability names and reasons, which are
 * long, and a rotated x-axis label is unreadable.
 */
export function barChart(data: readonly BarDatum[], options: { width?: number; barHeight?: number } = {}): string {
  if (data.length === 0) return `<p class="empty">No data.</p>`;

  const width = options.width ?? 640;
  const barHeight = options.barHeight ?? 22;
  const gap = 8;
  const labelWidth = 240;
  const chartWidth = width - labelWidth - 80;
  const height = data.length * (barHeight + gap) + gap;
  const max = Math.max(...data.map((item) => item.value), 1);

  const rows = data.map((item, index) => {
    const y = gap + index * (barHeight + gap);
    const barWidth = Math.max(2, (item.value / max) * chartWidth);
    const fill = item.warn === true ? "var(--warn)" : "var(--accent)";
    return `
      <g>
        <text x="0" y="${y + barHeight * 0.7}" class="chart-label">${escapeHtml(truncate(item.label, 34))}</text>
        <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3" fill="${fill}" />
        <text x="${labelWidth + barWidth + 8}" y="${y + barHeight * 0.7}" class="chart-value">${formatNumber(item.value)}</text>
      </g>`;
  });

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
    ${rows.join("")}
  </svg>`;
}

export interface HistogramDatum {
  bucket: string;
  count: number;
}

/** Vertical histogram, for latency. */
export function histogram(data: readonly HistogramDatum[], options: { width?: number; height?: number } = {}): string {
  if (data.length === 0) return `<p class="empty">No data.</p>`;

  const width = options.width ?? 640;
  const height = options.height ?? 160;
  const paddingBottom = 26;
  const paddingLeft = 34;
  const chartWidth = width - paddingLeft - 12;
  const chartHeight = height - paddingBottom - 8;
  const max = Math.max(...data.map((item) => item.count), 1);
  const slot = chartWidth / data.length;
  const barWidth = Math.max(2, slot - 2);

  const bars = data.map((item, index) => {
    const barHeight = Math.max(1, (item.count / max) * chartHeight);
    const x = paddingLeft + index * slot;
    const y = chartHeight - barHeight + 4;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="var(--accent)" rx="2">
      <title>${escapeHtml(item.bucket)}: ${item.count}</title>
    </rect>`;
  });

  // Only the first and last bucket labels, so a narrow chart stays readable.
  const first = data[0];
  const last = data[data.length - 1];
  const labels = `
    <text x="${paddingLeft}" y="${height - 6}" class="chart-axis">${escapeHtml(first?.bucket ?? "")}</text>
    <text x="${width - 12}" y="${height - 6}" text-anchor="end" class="chart-axis">${escapeHtml(last?.bucket ?? "")}</text>
    <text x="0" y="14" class="chart-axis">${max}</text>
    <text x="0" y="${chartHeight}" class="chart-axis">0</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">
    ${bars.join("")}${labels}
  </svg>`;
}

/**
 * A 2x2 confusion table for the outcome benchmark.
 *
 * This is the deliverable that a single average hides, so it is rendered as a table rather than as
 * a chart: the reader has to be able to read the individual counts, especially the one where
 * injection made things worse.
 */
export function confusionTable(input: {
  both: number;
  onlyControl: number;
  onlyTreatment: number;
  neither: number;
}): string {
  return `<table class="confusion">
    <thead>
      <tr><th></th><th>Control passed</th><th>Control failed</th></tr>
    </thead>
    <tbody>
      <tr>
        <th>Injected passed</th>
        <td class="good">${input.both}</td>
        <td class="good">${input.onlyTreatment}</td>
      </tr>
      <tr>
        <th>Injected failed</th>
        <td class="bad">${input.onlyControl}</td>
        <td>${input.neither}</td>
      </tr>
    </tbody>
  </table>`;
}

/** Bucket latencies for the histogram. */
export function latencyBuckets(latencies: readonly number[], bucketCount = 12): HistogramDatum[] {
  if (latencies.length === 0) return [];
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  if (max === min) return [{ bucket: `${Math.round(min)}ms`, count: latencies.length }];

  const step = (max - min) / bucketCount;
  const buckets: HistogramDatum[] = Array.from({ length: bucketCount }, (_, index) => ({
    bucket: `${Math.round(min + index * step)}ms`,
    count: 0,
  }));

  for (const value of latencies) {
    const index = Math.min(bucketCount - 1, Math.floor((value - min) / step));
    const bucket = buckets[index];
    if (bucket !== undefined) bucket.count += 1;
  }

  return buckets;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Round for display without pretending to more precision than the measurement has. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "–";
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 0.01) return value.toExponential(1);
  return value.toFixed(3);
}

/** Format a rate as a percentage, or an em dash when there is nothing to divide by. */
export function formatRate(value: number | null): string {
  if (value === null) return "–";
  return `${(value * 100).toFixed(1)}%`;
}
