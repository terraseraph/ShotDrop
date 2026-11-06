import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {},
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // SHOTDROP_VITE_PORT lets a second dev copy run beside the first (see README, Getting started).
    server: { host: '127.0.0.1', port: Number(process.env.SHOTDROP_VITE_PORT) || 5173, strictPort: true },
    plugins: [react()]
  }
})
