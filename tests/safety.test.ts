// Safety: NO code path can execute a real trade. SPEC §6, §15.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("safety", () => {
  it("EXECUTE_REAL_TRADES is forced false in config", async () => {
    const configModule = await import("../src/lib/config.js");
    expect(configModule.config.EXECUTE_REAL_TRADES).toBe("false");
  });

  it("config.ts source has the safety invariant", () => {
    const configSrc = fs.readFileSync(path.join(ROOT, "src/lib/config.ts"), "utf-8");
    expect(configSrc).toContain("EXECUTE_REAL_TRADES");
    expect(configSrc).toContain('throw new Error("EXECUTE_REAL_TRADES must be false');
  });

  it("no adapter exports an execute/send/order function", async () => {
    const modules = await Promise.all([
      import("../src/adapters/polymarket.js"),
      import("../src/adapters/trades.js"),
      import("../src/adapters/leaderboard.js"),
      import("../src/adapters/telegram.js"),
      import("../src/adapters/hermes.js"),
    ]);

    const executeKeywords = ["execute", "sendOrder", "placeTrade", "submit"];
    for (const mod of modules) {
      const keys = Object.keys(mod);
      for (const key of keys) {
        for (const kw of executeKeywords) {
          expect(key.toLowerCase()).not.toContain(kw);
        }
      }
    }
  });

  it("createPaperTrade source has no network calls", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/paper.ts"), "utf-8");
    // Comments and docstrings may contain "execute" / "order" — only flag actual calls
    const noCalls = src
      .replace(/\/\/.*$/gm, "")      // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, ""); // strip block comments
    expect(noCalls).not.toMatch(/fetch|axios|http:\/\/|https:\/\/|\.send\(|WebSocket/i);
  });
});
