import { describe, expect, it } from "vitest";
import type { OrderBook } from "../src/adapters/polymarket.js";
import { quoteBuySharesExact, quoteBuyWithCash } from "../src/lib/executableQuotes.js";

function book(bids: Array<[number, number]>, asks: Array<[number, number]>): OrderBook {
  return {
    market: "0xmarket",
    asset_id: "asset",
    bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
    asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
    min_order_size: "1",
    tick_size: "0.01",
    neg_risk: false,
  };
}

describe("cash-budget buy quote", () => {
  it("applies FeeModel.exponent, not an implicit exponent of 1", () => {
    const orderBook = book([[0.49, 100]], [[0.50, 100]]);
    const fee = { rateBps: 2500, exponent: 2 };
    const quote = quoteBuyWithCash(orderBook, fee, 10);
    expect(quote).not.toBeNull();

    // 0.25 * (0.5 * 0.5) ** 2 = 0.015625 per share; an implicit exponent 1 would give 0.0625.
    const feePerShare = quote!.fee / quote!.shares;
    expect(feePerShare).toBeCloseTo(0.015625, 8);
    expect(feePerShare).not.toBeCloseTo(0.0625, 4);
  });

  it("matches the exact-share quote when the cash budget equals that quote's cost", () => {
    const orderBook = book([[0.49, 100]], [[0.50, 80], [0.52, 120]]);
    const fee = { rateBps: 1000, exponent: 2 };
    const exact = quoteBuySharesExact(orderBook, fee, 150);
    expect(exact).not.toBeNull();

    const budget = quoteBuyWithCash(orderBook, fee, exact!.cashCost);
    expect(budget).not.toBeNull();
    expect(budget!.shares).toBeCloseTo(exact!.shares, 6);
    expect(budget!.cashCost).toBeCloseTo(exact!.cashCost, 6);
    expect(budget!.fee).toBeCloseTo(exact!.fee, 6);
  });
});
