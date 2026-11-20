import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The platform admin app: add and maintain dealers. Its own sign-in; it only calls /v1/admin.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Hosted (Railway) the API serves this app at /admin/, next to the dashboard (/) and shop (/shop/).
  base: command === "build" ? "/admin/" : "/",
  server: {
    port: 5182,
    strictPort: true,
    proxy: { "/v1/admin": `http://localhost:${process.env.API_PORT ?? 3100}` },
  },
}));
