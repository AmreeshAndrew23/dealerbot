import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The customer app. Separate from the staff dashboard (apps/web, port 5180): its own address,
// its own sign-in, and it only ever calls the /v1/app routes.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Hosted (Railway) the API serves this app at /shop/, next to the dashboard at /.
  base: command === "build" ? "/shop/" : "/",
  server: {
    port: 5181,
    strictPort: true,
    // Reachable from a phone on the same Wi-Fi: http://<this-PC's-IP>:5181
    host: true,
    // Same-origin in development so the session cookie works without CORS.
    proxy: { "/v1/app": `http://localhost:${process.env.API_PORT ?? 3100}` },
  },
}));
