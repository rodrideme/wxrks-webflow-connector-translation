/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Design-system tokens -- values live as CSS custom properties in
        // index.css (light + prefers-color-scheme:dark), so every class
        // below is theme-aware with no `dark:` variants needed anywhere.
        canvas: "var(--canvas)",
        surface: { DEFAULT: "var(--surface)", sunken: "var(--surface-sunken)" },
        border: { DEFAULT: "var(--border)", strong: "var(--border-strong)" },
        ink: { DEFAULT: "var(--text)", soft: "var(--text-soft)", faint: "var(--text-faint)" },
        accent: {
          DEFAULT: "var(--accent)",
          strong: "var(--accent-strong)",
          subtle: "var(--accent-subtle)",
          text: "var(--accent-text)",
        },
        // Kept for any leftover references during the transition; new code
        // should use the tokens above instead.
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          500: "#3b5bfd",
          600: "#2f47db",
          700: "#2739b0",
          900: "#0d1117",
        },
        status: {
          draft: { fg: "var(--draft-fg)", bg: "var(--draft-bg)", dot: "var(--draft-dot)" },
          progress: { fg: "var(--prog-fg)", bg: "var(--prog-bg)", dot: "var(--prog-dot)" },
          success: { fg: "var(--success-fg)", bg: "var(--success-bg)", dot: "var(--success-dot)" },
          error: { fg: "var(--error-fg)", bg: "var(--error-bg)", dot: "var(--error-dot)" },
          auto: { fg: "var(--auto-fg)", bg: "var(--auto-bg)", dot: "var(--auto-dot)" },
        },
      },
      boxShadow: {
        card: "0 1px 2px rgba(20,22,40,0.04), 0 1px 1px rgba(20,22,40,0.03)",
      },
    },
  },
  plugins: [],
};
