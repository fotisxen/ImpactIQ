import { ChartOptions } from 'chart.js';

/**
 * Chart.js reads colors from JS config, not CSS custom properties, so these
 * mirror the dark-theme tokens in styles.scss. Keep in sync if the palette
 * there changes.
 */
export const chartPalette = {
  accent: '#ff7a29',
  accent2: '#3aa0ff',
  positive: '#35d07f',
  textMuted: '#8b94a8',
  grid: '#262d3d',
  surfaceRaised: '#171c27',
} as const;

export const baseChartOptions: ChartOptions<'bar' | 'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  color: chartPalette.textMuted,
  scales: {
    x: {
      ticks: { color: chartPalette.textMuted, font: { size: 11 } },
      grid: { color: chartPalette.grid },
      border: { color: chartPalette.grid },
    },
    y: {
      ticks: { color: chartPalette.textMuted, font: { size: 11 } },
      grid: { color: chartPalette.grid },
      border: { display: false },
      beginAtZero: true,
    },
  },
  plugins: {
    legend: {
      labels: { color: chartPalette.textMuted, font: { size: 11 }, usePointStyle: true },
    },
    tooltip: {
      backgroundColor: chartPalette.surfaceRaised,
      titleColor: '#e9edf5',
      bodyColor: chartPalette.textMuted,
      borderColor: chartPalette.grid,
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    },
  },
};
