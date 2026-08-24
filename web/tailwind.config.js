/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f3eee4",
        ink: "#1c1915",
        muted: "#6b6358",
        line: "#d9d0c3",
        card: "#faf7f1",
        seal: "#b23a2f",
        "seal-dark": "#8e2e25",
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Noto Serif SC", "serif"],
        sans: ["var(--font-sans)", "Noto Sans SC", "sans-serif"],
      },
    },
  },
  plugins: [],
};
