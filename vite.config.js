import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const rawAllowedHosts =
    process.env.VITE_ALLOWED_HOSTS ||
    process.env.VITE_ALLOWED_HOST ||
    env.VITE_ALLOWED_HOSTS ||
    env.VITE_ALLOWED_HOST ||
    ''
  const allowedHosts = Array.from(
    new Set(
      rawAllowedHosts
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
    ),
  )

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts,
    },
  }
})
