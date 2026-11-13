import { defineConfig, type Plugin } from 'vite';
import { handleApi } from './server/api';

/** Serves /api/* from the dev server so the Anthropic key never reaches the browser. */
function studioApi(): Plugin {
  return {
    name: 'studio-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        handleApi(req, res).then((handled) => { if (!handled) next(); }, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [studioApi()],
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node' },
} as never);
