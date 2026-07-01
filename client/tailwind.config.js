/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#d9e6ff",
          500: "#3b5bfd",
          600: "#2f47db",
          700: "#2739b0",
          900: "#0d1117",
        },
      },
    },
  },
  plugins: [],
};
