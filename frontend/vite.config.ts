import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    // The MQTT tool's mqtt.js dependency (and its own dependencies, e.g.
    // mqtt-packet/readable-stream) assume Node's Buffer/process/global exist
    // even in its browser build -- Vite/esbuild, unlike webpack, doesn't
    // polyfill those automatically, so without this the client can silently
    // fail once it needs to parse a real MQTT packet (anything past the
    // initial CONNACK), instead of throwing a clear "process is not defined".
    nodePolyfills({ include: ["buffer", "process"] }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.BACKEND_URL || "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
