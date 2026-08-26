import dotenv from "dotenv";
dotenv.config({ path: "/var/lib/trading-bots/polymarket-bot/.env" });

import { getTradingClient } from "./src/adapters/execution.js";
import { Side, OrderType } from "@polymarket/clob-client-v2";

async function main() {
  const trading = getTradingClient();
  console.log("CLOB Methods on client:", Object.getOwnPropertyNames(Object.getPrototypeOf(trading)));
  
  // 1. Integer shares test
  const orderInt = await trading.createOrder({
    tokenID: "9278936404033137791117212740087548922835174537803981519886850522383849577435",
    price: 0.65,
    size: 10, // integer shares -> size * price = 6.50
    side: Side.BUY,
  });
  console.log("Integer shares order (size=10, price=0.65):", orderInt);
  
  // 2. Check market order method if available
  if (typeof (trading as any).createMarketBuyOrder === "function") {
    console.log("createMarketBuyOrder is available!");
  }
}

main().catch(console.error);
