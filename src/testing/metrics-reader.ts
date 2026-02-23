/**
 * Test helper: parse Prometheus exposition format for metric assertions.
 *
 * Avoids HTTP — reads metrics directly from AOFMetrics instance.
 */

import type { AOFMetrics } from "../metrics/exporter.js";

export async function getMetricValue(
  metrics: AOFMetrics,
  metricName: string,
  labels?: Record<string, string>,
): Promise<number | null> {
  const output = await metrics.getMetrics();
  for (const line of output.split("\n")) {
    if (line.startsWith("#")) continue;
    if (!line.startsWith(metricName)) continue;
    if (labels) {
      const allMatch = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
      if (!allMatch) continue;
    }
    const parts = line.split(" ");
    const val = parseFloat(parts[parts.length - 1] ?? "NaN");
    return isNaN(val) ? null : val;
  }
  return null;
}
