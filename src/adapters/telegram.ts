// Telegram sendMessage. No-op silently if TELEGRAM_BOT_TOKEN unset.
import { config } from "../lib/config.js";

export async function sendMessage(text: string): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // ponytail: no-op if not configured
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API failed: ${res.status} ${body}`);
  }
}
