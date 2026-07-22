/**
 * LANE B — Independent shadow loop.
 * Polls every three minutes and triggers an immediate scan on Sports WS finals.
 */
import WebSocket from "ws";
import { runLaneBScan, type SportsResult } from "./laneBShadow.js";

const INTERVAL_MS = 3 * 60 * 1000;
const SPORTS_WS = "wss://sports-api.polymarket.com/ws";
const MAX_RECONNECT_MS = 60_000;

const sportsResults = new Map<string, SportsResult>();
let websocket: WebSocket | null = null;
let reconnectDelay = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let scanRunning = false;
let scanPending = false;

function normalizeSportsMessages(raw: unknown): SportsResult[] {
  const values = Array.isArray(raw) ? raw : [raw];
  const results: SportsResult[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const candidate = record.data && typeof record.data === "object"
      ? record.data as Record<string, unknown>
      : record;
    if (typeof candidate.slug !== "string") continue;
    results.push(candidate as unknown as SportsResult);
  }
  return results;
}

async function requestScan(reason: string): Promise<void> {
  if (scanRunning) {
    scanPending = true;
    return;
  }
  do {
    scanPending = false;
    scanRunning = true;
    try {
      console.log(`\n--- Lane B scan (${reason}) @ ${new Date().toISOString()} ---`);
      await runLaneBScan(sportsResults.values());
    } catch (error) {
      console.error("Lane B scan error:", error instanceof Error ? error.message : String(error));
    } finally {
      scanRunning = false;
    }
  } while (scanPending);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSportsWebSocket();
  }, delay);
  reconnectTimer.unref?.();
}

function connectSportsWebSocket(): void {
  if (websocket && (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING)) return;
  websocket = new WebSocket(SPORTS_WS);

  websocket.on("open", () => {
    reconnectDelay = 1_000;
    console.log("Sports WebSocket connected.");
  });

  websocket.on("message", (data) => {
    const text = data.toString();
    if (text === "ping") {
      if (websocket?.readyState === WebSocket.OPEN) websocket.send("pong");
      return;
    }
    try {
      const parsed = JSON.parse(text);
      for (const result of normalizeSportsMessages(parsed)) {
        const previous = sportsResults.get(result.slug);
        sportsResults.set(result.slug, result);
        if (result.ended === true && previous?.ended !== true) {
          console.log(`Sports final: ${result.slug} | ${result.status ?? "ended"} | ${result.score ?? ""}`);
          void requestScan("sports-final");
        }
      }
    } catch {
      // Ignore non-JSON control messages.
    }
  });

  websocket.on("error", (error) => {
    console.error("Sports WebSocket error:", error.message);
  });

  websocket.on("close", () => {
    websocket = null;
    console.error("Sports WebSocket disconnected; reconnecting.");
    scheduleReconnect();
  });
}

process.on("SIGINT", () => {
  websocket?.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  websocket?.close();
  process.exit(0);
});
process.on("uncaughtException", (error) => console.error("Lane B uncaughtException:", error.message));
process.on("unhandledRejection", (error) => console.error("Lane B unhandledRejection:", error));

console.log("=== LANE B: Resolution-Lag Shadow Logger ===");
console.log(`Poll interval: ${INTERVAL_MS / 1000}s | Sports WS: ${SPORTS_WS}`);
console.log("Storage: data/laneb_shadow.json | Main pipeline untouched.\n");

connectSportsWebSocket();
void requestScan("startup");
setInterval(() => void requestScan("interval"), INTERVAL_MS);
