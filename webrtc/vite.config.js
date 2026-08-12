// vite.config.js
import { defineConfig } from 'vite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.js',
      formats: ['iife'],
      name: 'MagpieWebrtc',
      fileName: () => 'magpie-webrtc.js'
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  },

  plugins: [
    {
      name: 'copy-client',
      closeBundle() {
        const source = resolve('dist/magpie-webrtc.js')
        const target = resolve('../src/public/magpie-webrtc.js')

        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
      }
    }
  ]
})
