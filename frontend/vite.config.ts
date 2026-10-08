import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Which build this is. Compiled into the app and written beside index.html as
// version.json, so a tab left open across a deploy can tell it's stale
// (src/appBuild.ts). Unique per build; a deployment may pin it instead.
const BUILD_ID = process.env.APP_BUILD_ID || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function versionFile(): Plugin {
  const body = JSON.stringify({ build: BUILD_ID });
  return {
    name: "version-file",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: body });
    },
    // The dev server answers it too (same id, so never stale while it runs):
    // a 404 there was a console error every few minutes, and the browser
    // suites can stand in a newer build by routing this one request.
    configureServer(server) {
      server.middlewares.use("/version.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    versionFile(),
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
