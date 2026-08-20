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

/** A distinct-enough rotation for charts that need one color per team/player rather than a fixed 2-3 series. */
export const categoricalPalette = [
  '#ff7a29', '#3aa0ff', '#35d07f', '#e0c048', '#c774e8',
  '#ff5c8a', '#4dd0e1', '#ffb74d', '#9575cd', '#81c784',
  '#f06292', '#64b5f6', '#a1887f', '#dce775', '#ba68c8',
] as const;

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

/** Opta-style percentile radar — every axis is a 0-100 percentile rank within the league, so shape is directly comparable across players regardless of stat scale. */
export const percentileRadarChartOptions: ChartOptions<'radar'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    r: {
      angleLines: { color: chartPalette.grid },
      grid: { color: chartPalette.grid },
      pointLabels: { color: chartPalette.textMuted, font: { size: 12 } },
      ticks: { color: chartPalette.textMuted, backdropColor: 'transparent', font: { size: 10 }, stepSize: 20 },
      min: 0,
      max: 100,
    },
  },
  plugins: {
    legend: legendStyle,
    tooltip: {
      ...tooltipStyle,
      callbacks: {
        label: (ctx) => `${ctx.label}: ${ctx.formattedValue}th percentile`,
      },
    },
  },
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

/** Bump chart — team rank over time. Y-axis reversed so rank 1 sits at the top, like a real standings bump chart. */
export const bumpChartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'nearest', intersect: false },
  scales: {
    x: {
      ticks: { color: chartPalette.textMuted, font: { size: 10 }, maxRotation: 0 },
      grid: { display: false },
      border: { color: chartPalette.grid },
    },
    y: {
      reverse: true,
      min: 1,
      ticks: { color: chartPalette.textMuted, font: { size: 11 }, stepSize: 1, precision: 0 },
      grid: { color: chartPalette.grid },
      border: { display: false },
      title: { display: true, text: 'Rank', color: chartPalette.textMuted },
    },
  },
  plugins: { legend: legendStyle, tooltip: tooltipStyle },
};

/** Win probability over the course of one game — a filled area from 0-100%, home team's perspective. */
export const winProbabilityChartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      ticks: { color: chartPalette.textMuted, font: { size: 10 } },
      grid: { display: false },
      border: { color: chartPalette.grid },
      title: { display: true, text: 'Game clock', color: chartPalette.textMuted },
    },
    y: {
      min: 0,
      max: 100,
      ticks: {
        color: chartPalette.textMuted,
        font: { size: 11 },
        callback: (v) => `${v}%`,
      },
      grid: { color: chartPalette.grid },
      border: { display: false },
    },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      ...tooltipStyle,
      callbacks: {
        label: (ctx) => `${(ctx.raw as number).toFixed(0)}% win probability (estimate)`,
      },
    },
  },
};

/** Ridgeline plot — each dataset is one subject's distribution curve, vertically offset. The Y-axis is a synthetic offset, not a real scale, so it's hidden. */
export const ridgelineChartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      ticks: { color: chartPalette.textMuted, font: { size: 11 } },
      grid: { color: chartPalette.grid },
      border: { color: chartPalette.grid },
    },
    y: {
      display: false,
    },
  },
  plugins: {
    legend: { labels: { color: chartPalette.textMuted, font: { size: 11 }, usePointStyle: true } },
    tooltip: { enabled: false },
  },
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
