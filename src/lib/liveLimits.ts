export interface LiveLimits {
  maxOpenPositions: number;
  maxPositionUsd: number;
  maxExposureUsd: number;
}

export interface LiveExposure {
  openPositions: number;
  exposureUsd: number;
  cashBudget: number;
}

const PAPER_MAX_POSITION_USD = 20;

/** Preserve the paper confidence ratio while fitting the live position cap. */
export function liveCashBudgetForPaper(paperCashBudget: number, liveMaxPositionUsd: number): number {
  if (!Number.isFinite(paperCashBudget) || paperCashBudget <= 0) return 0;
  if (!Number.isFinite(liveMaxPositionUsd) || liveMaxPositionUsd <= 0) return 0;
  const paperBudget = Math.min(paperCashBudget, PAPER_MAX_POSITION_USD);
  return Math.round((paperBudget * liveMaxPositionUsd / PAPER_MAX_POSITION_USD) * 100) / 100;
}

export function liveLimitReason(exposure: LiveExposure, limits: LiveLimits): string | null {
  if (!Number.isFinite(exposure.cashBudget) || exposure.cashBudget <= 0) return "invalid-position-size";
  if (exposure.cashBudget > limits.maxPositionUsd + 0.005) return "position-size-cap";
  if (exposure.openPositions >= limits.maxOpenPositions) return "open-position-cap";
  if (exposure.exposureUsd + exposure.cashBudget > limits.maxExposureUsd + 0.005) return "exposure-cap";
  return null;
}
