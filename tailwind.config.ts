import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Max HQ-friendly neutral palette
        ink: "#0b0e14",
        panel: "#121722",
        edge: "#1f2733",
        muted: "#8b97a8",
        good: "#3fb950",
        bad: "#f85149",
        warn: "#d29922",
      },
    },
  },
  plugins: [],
};
export default config;
