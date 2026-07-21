import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Hermes Polymarket Bot",
  description: "Paper-trading research dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink text-white min-h-screen antialiased">{children}</body>
    </html>
  );
}
