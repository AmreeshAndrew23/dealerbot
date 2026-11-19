import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Reachable from a phone on the same Wi-Fi: http://<this-PC's-IP>:5180
    host: true,
    // Same-origin in development so the session cookie works without CORS. /webhooks and /health
    // are forwarded too, so one tunnel (e.g. ngrok to this port) serves the dashboard and Meta.
    proxy: Object.fromEntries(["/v1", "/webhooks", "/health"].map((p) => [p, `http://localhost:${process.env.API_PORT ?? 3100}`])),
  },
});
