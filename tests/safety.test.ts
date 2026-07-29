import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("live execution gate", () => {
  it("is disabled by default", async () => {
    const config = await import("../src/lib/config.js");
    expect(config.realTradingEnabled).toBe(false);
    expect(() => config.assertLiveTradingConfigured()).toThrow("Live trading is disabled");
  });

  it("requires an explicit gate and credentials", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/lib/config.ts"), "utf8");
    expect(source).toContain('EXECUTE_REAL_TRADES: z.enum(["true", "false"]).default("false")');
    expect(source).toContain("assertLiveTradingConfigured");
    expect(source).toContain("CLOB_API_SECRET");
    expect(source).toContain("POLYMARKET_PRIVATE_KEY");
  });

  it("keeps the paper engine network-free", () => {
    const file = path.join(ROOT, "src/lib/paper.ts");
    if (!fs.existsSync(file)) return;
    const source = fs.readFileSync(file, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/fetch|axios|http:\/\/|https:\/\/|\.send\(|WebSocket/i);
  });

  it("loads the Lane A live module without placing an order", async () => {
    const { executeWalletCopyOrder } = await import("../src/lib/liveExecution.js");
    expect(typeof executeWalletCopyOrder).toBe("function");
  }, 15_000);

  it("loads the live-resolution lifecycle without touching an order", async () => {
    const { runReviewOutcomes } = await import("../src/jobs/reviewOutcomes.js");
    expect(typeof runReviewOutcomes).toBe("function");
  }, 15_000);

});
