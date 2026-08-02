import { prisma } from "./db.js";
import { getRuntimeContext } from "./runtime.js";

export const LOGIC_VERSION = "v5-wallet-copy-profitability";

export interface DecisionJournalInput {
  observedTradeId: string;
  walletAddress: string;
  marketId: string;
  decision: "paper_copy" | "watchlist" | "skip";
  copyScore?: number | null;
  confidence?: number | null;
  reasons?: string[];
  reasonsJson?: string;
  risksJson?: string | null;
  walletQualityScore?: number | null;
  roiScore?: number | null;
  consistencyScore?: number | null;
  copyabilityScore?: number | null;
  categoryFitScore?: number | null;
  entryTimingScore?: number | null;
  spreadScore?: number | null;
  liquidityScore?: number | null;
  thesisScore?: number | null;
  simulatedPositionSize?: number | null;
  ruleSetId?: string | null;
  ruleSetVersion?: number | null;
  walletStatus?: string | null;
  sourceRank?: number | null;
  marketSegment?: string | null;
  priorSameSegmentResolvedCount?: number | null;
  priorSameSegmentWins?: number | null;
  priorSameSegmentAveragePnl?: number | null;
  signalAgeSeconds?: number | null;
  firstFailingGate: string;
  intendedPositionSize?: number | null;
  eventExposureBefore?: number | null;
  executableAsk?: number | null;
  allInPrice?: number | null;
  fee?: number | null;
  spread?: number | null;
  shares?: number | null;
}

export async function createDecisionJournal(input: DecisionJournalInput) {
  const runtime = getRuntimeContext();
  return prisma.decisionJournal.create({
    data: {
      observedTradeId: input.observedTradeId,
      walletAddress: input.walletAddress,
      marketId: input.marketId,
      decision: input.decision,
      copyScore: input.copyScore ?? null,
      confidence: input.confidence ?? null,
      reasonsJson: input.reasonsJson ?? JSON.stringify(input.reasons ?? []),
      risksJson: input.risksJson ?? null,
      walletQualityScore: input.walletQualityScore ?? null,
      roiScore: input.roiScore ?? null,
      consistencyScore: input.consistencyScore ?? null,
      copyabilityScore: input.copyabilityScore ?? null,
      categoryFitScore: input.categoryFitScore ?? null,
      entryTimingScore: input.entryTimingScore ?? null,
      spreadScore: input.spreadScore ?? null,
      liquidityScore: input.liquidityScore ?? null,
      thesisScore: input.thesisScore ?? null,
      simulatedPositionSize: input.simulatedPositionSize ?? null,
      logicVersion: LOGIC_VERSION,
      gitSha: runtime.gitSha,
      runId: runtime.runId,
      ruleSetId: input.ruleSetId ?? null,
      ruleSetVersion: input.ruleSetVersion ?? null,
      walletStatus: input.walletStatus ?? null,
      sourceRank: input.sourceRank ?? null,
      marketSegment: input.marketSegment ?? null,
      priorSameSegmentResolvedCount: input.priorSameSegmentResolvedCount ?? null,
      priorSameSegmentWins: input.priorSameSegmentWins ?? null,
      priorSameSegmentAveragePnl: input.priorSameSegmentAveragePnl ?? null,
      signalAgeSeconds: input.signalAgeSeconds ?? null,
      firstFailingGate: input.firstFailingGate,
      intendedPositionSize: input.intendedPositionSize ?? null,
      eventExposureBefore: input.eventExposureBefore ?? null,
      executableAsk: input.executableAsk ?? null,
      allInPrice: input.allInPrice ?? null,
      fee: input.fee ?? null,
      spread: input.spread ?? null,
      shares: input.shares ?? null,
    },
  });
}
