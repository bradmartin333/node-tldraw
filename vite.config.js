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
  // Vite matches this against the bare Host header, so an entry like
  // "http://localhost:3000" never matches and yields a confusing 403. Strip any
  // protocol and port so a URL-shaped value still does the right thing.
  const toHostname = (value) =>
    value
      .trim()
      .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')

  const hosts = Array.from(
    new Set(rawAllowedHosts.split(',').map(toHostname).filter(Boolean)),
  )

  // "*" disables the host check entirely (Vite's `true`), which is what a
  // container published on an arbitrary hostname or LAN IP needs.
  const allowedHosts = hosts.includes('*') ? true : hosts

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
