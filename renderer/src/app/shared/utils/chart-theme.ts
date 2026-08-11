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

const tooltipStyle = {
  backgroundColor: chartPalette.surfaceRaised,
  titleColor: '#e9edf5',
  bodyColor: chartPalette.textMuted,
  borderColor: chartPalette.grid,
  borderWidth: 1,
  padding: 10,
  cornerRadius: 8,
} as const;

const legendStyle = {
  labels: { color: chartPalette.textMuted, font: { size: 11 }, usePointStyle: true },
} as const;

export const radarChartOptions: ChartOptions<'radar'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    r: {
      angleLines: { color: chartPalette.grid },
      grid: { color: chartPalette.grid },
      pointLabels: { color: chartPalette.textMuted, font: { size: 12 } },
      ticks: { color: chartPalette.textMuted, backdropColor: 'transparent', font: { size: 10 } },
      min: 0,
    },
  },
  plugins: { legend: legendStyle, tooltip: tooltipStyle },
};

export const doughnutChartOptions: ChartOptions<'doughnut'> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: legendStyle, tooltip: tooltipStyle },
};

export const polarAreaChartOptions: ChartOptions<'polarArea'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    r: {
      angleLines: { color: chartPalette.grid },
      grid: { color: chartPalette.grid },
      pointLabels: { color: chartPalette.textMuted },
      ticks: { color: chartPalette.textMuted, backdropColor: 'transparent', font: { size: 10 } },
      min: 0,
    },
  },
  plugins: { legend: legendStyle, tooltip: tooltipStyle },
};

export const bubbleChartOptions: ChartOptions<'bubble'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      title: { display: true, text: 'Shot attempts (FGA)', color: chartPalette.textMuted },
      ticks: { color: chartPalette.textMuted, font: { size: 11 } },
      grid: { color: chartPalette.grid },
    },
    y: {
      title: { display: true, text: 'True Shooting %', color: chartPalette.textMuted },
      ticks: { color: chartPalette.textMuted, font: { size: 11 } },
      grid: { color: chartPalette.grid },
      beginAtZero: true,
    },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      ...tooltipStyle,
      callbacks: {
        label: (ctx) => {
          const raw = ctx.raw as { x: number; y: number; r: number };
          return `${raw.x} FGA, ${raw.y.toFixed(1)}% TS, ${Math.round(raw.r * 2)} PTS`;
        },
      },
    },
  },
};
