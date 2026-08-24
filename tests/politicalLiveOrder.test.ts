import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mockPrisma: {
    decisionJournal: { create: vi.fn() },
    paperTrade: { update: vi.fn() },
  },
  mockExecuteWalletCopyOrder: vi.fn(),
}));

vi.mock("../src/lib/db.js", () => ({ prisma: mocks.mockPrisma }));
vi.mock("../src/lib/liveExecution.js", () => ({
  executeWalletCopyOrder: mocks.mockExecuteWalletCopyOrder,
}));

import { tryPoliticalLiveOrder } from "../src/jobs/scanPoliticalFavorites.js";

describe("tryPoliticalLiveOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseParams = {
    paperTradeId: "pt-1",
    buy: { cashCost: 10, allInPrice: 0.75, shares: 13.33, fee: 0.15, spread: 0.01, averageAsk: 0.76, bestBid: 0.74, bestAsk: 0.76 },
    tokenId: "tok-1",
    marketId: "mkt-1",
    slug: "president-2028",
    outcome: "Yes",
    reasons: ["electoral favorite: Yes", "executable ask=0.7600"],
  };

  it("does nothing when realTradingEnabled is false", async () => {
    const result = await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: false });
    expect(result).toBeNull();
    expect(mocks.mockPrisma.decisionJournal.create).not.toHaveBeenCalled();
    expect(mocks.mockPrisma.paperTrade.update).not.toHaveBeenCalled();
    expect(mocks.mockExecuteWalletCopyOrder).not.toHaveBeenCalled();
  });

  it("creates a DecisionJournal with nullable observedTradeId when enabled", async () => {
    const mockDj = { id: "dj-1" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockResolvedValue(undefined);

    const result = await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });

    expect(mocks.mockPrisma.decisionJournal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          observedTradeId: null,
          walletAddress: "STRATEGY:political_favorites",
          marketId: "mkt-1",
          decision: "paper_copy",
        }),
      }),
    );
    expect(result).toEqual({ decisionJournalId: "dj-1" });
  });

  it("passes fixed 10 cashBudget (not scaled)", async () => {
    const mockDj = { id: "dj-2" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockResolvedValue(undefined);

    await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });

    expect(mocks.mockExecuteWalletCopyOrder).toHaveBeenCalledWith(
      expect.objectContaining({ cashBudget: 10 }),
    );
  });

  it("links the PaperTrade to the DecisionJournal", async () => {
    const mockDj = { id: "dj-3" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockResolvedValue(undefined);

    await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });

    expect(mocks.mockPrisma.paperTrade.update).toHaveBeenCalledWith({
      where: { id: "pt-1" },
      data: { decisionJournalId: "dj-3" },
    });
  });

  it("preserves PaperTrade even when executeWalletCopyOrder throws", async () => {
    const mockDj = { id: "dj-4" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockRejectedValue(new Error("live execution failed"));

    const result = await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });

    expect(mocks.mockPrisma.decisionJournal.create).toHaveBeenCalled();
    expect(mocks.mockPrisma.paperTrade.update).toHaveBeenCalled();
    expect(result?.decisionJournalId).toBe("dj-4");
  });

  it("passes correct walletAddress STRATEGY:political_favorites", async () => {
    const mockDj = { id: "dj-5" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockResolvedValue(undefined);

    await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });

    expect(mocks.mockExecuteWalletCopyOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: "STRATEGY:political_favorites",
        tokenId: "tok-1",
        marketId: "mkt-1",
        slug: "president-2028",
      }),
    );
  });

  it("does not rethrow from failed execution (caller scan loop continues)", async () => {
    const mockDj = { id: "dj-6" };
    mocks.mockPrisma.decisionJournal.create.mockResolvedValue(mockDj);
    mocks.mockPrisma.paperTrade.update.mockResolvedValue({});
    mocks.mockExecuteWalletCopyOrder.mockRejectedValue(new Error("network error"));

    const result = await tryPoliticalLiveOrder({ ...baseParams, realTradingEnabled: true });
    // The caller sees a normal return, not an exception — scan loop continues
    expect(result).not.toBeNull();
    expect(result!.decisionJournalId).toBe("dj-6");
  });
});