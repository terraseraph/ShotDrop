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
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    plugins: [react()]
  }
})
