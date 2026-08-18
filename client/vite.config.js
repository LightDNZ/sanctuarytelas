import { defineConfig } from 'vite';

export default defineConfig({
  // O .env fica na raiz do projeto, não dentro de client/.
  envDir: '..',
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // Permitir que o Vite leia variáveis de ambiente da pasta raiz
  envPrefix: ['VITE_'],
});
