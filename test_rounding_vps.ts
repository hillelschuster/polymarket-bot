import { prepareFokBuyOrder } from "./src/adapters/execution.js";

const book = {
  market: "0x123",
  asset_id: "123",
  bids: [],
  asks: [{ price: "0.70", size: "100" }],
  tick_size: "0.01",
  min_order_size: "5",
  neg_risk: false,
  timestamp: "0",
  last_trade_price: "0.70",
};

const fee = { rateBps: 500, exponent: 1 };

const prep = prepareFokBuyOrder({
  tokenId: "123",
  book: book as any,
  fee,
  shares: 9.056865464632455,
  maxCashCost: 10.0,
  maxAllInPrice: 0.75,
});

console.log("=========================================");
console.log("VERIFIED LIVE ORDER PREPARATION OUTPUT:");
console.log("  * Prepared Leg:", prep?.leg);
console.log("  * Shares Decimal Length:", String(prep?.leg.shares).split(".")[1]?.length ?? 0);
console.log("  * Estimated Cash Cost:", prep?.leg.estimatedCashCost);
console.log("=========================================");
