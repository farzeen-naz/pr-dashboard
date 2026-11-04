import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        gh: {
          canvas: "#f6f8fa",
          surface: "#ffffff",
          border: "#d1d9e0",
          "border-muted": "#d8dee4",
          fg: "#1f2328",
          "fg-muted": "#656d76",
          "accent-blue": "#ddf4ff",
          "accent-blue-hover": "#b6e3ff",
          "header-bg": "#f6f8fa",
        },
      },
    },
  },
  plugins: [],
};
export default config;
