import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/orbital-pursuit/', // 必须是这个，前后都有斜杠
})