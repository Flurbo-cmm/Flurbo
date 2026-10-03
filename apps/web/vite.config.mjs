import { defineConfig, loadEnv } from 'vite';
import { localApi } from './server/local-api.mjs';
import { envioProxy } from './server/envio-proxy.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const envioUrl = process.env.FLURBO_ENVIO_GRAPHQL_URL || env.FLURBO_ENVIO_GRAPHQL_URL;
  return {
  plugins: [{ name: 'flurbo-local-workspace', configureServer(server) {
    server.middlewares.use('/envio', (req, res) => { void envioProxy(req, res, envioUrl); });
    server.middlewares.use(localApi());
  } }],
  // Signed-in pages load on demand; styles stay in one file so every page keeps
  // the shared rules it relies on, whichever page loads first.
  build: { cssCodeSplit: false },
  };
});
