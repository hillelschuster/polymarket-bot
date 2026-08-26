import { getTradingClient } from "./src/adapters/execution.js";
import { OrderType } from "@polymarket/clob-client-v2";

async function test() {
  const trading = getTradingClient();
  // We place a 0.001 tick size buy order at a price of 0.01 for 9 shares.
  // 9 * 0.01 = 0.09 (this is 2 decimals! so it might pass)
  // Let's place it for 9 shares at 0.011 (3 decimals! 9 * 0.011 = 0.099)
  
  // Actually, just create the order and post it. Since it's price 0.01 it will never fill (FOK).
  try {
      const order = await trading.createOrder({
          tokenID: "9278936404033137791117212740087548922835174537803981519886850522383849577435", // some valid token ID
          price: 0.011,
          size: 9,
          side: 0 // BUY
      }, { tickSize: "0.001" });

      const resp = await trading.postOrder(order, OrderType.FOK);
      console.log("POST ORDER RESPONSE:", resp);
  } catch (err) {
      console.error("ERROR:", err.message || err);
  }
}
test();
