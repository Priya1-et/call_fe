import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

// Try to load self-signed cert (for HTTPS dev access via public IP).
// Falls back to plain HTTP if certs are missing (eg, on a fresh machine).
function loadHttps() {
  const certPath = process.env.VITE_TLS_CERT ?? '/etc/asterisk/tls/asterisk.crt'
  const keyPath = process.env.VITE_TLS_KEY ?? '/etc/asterisk/tls/asterisk.key'
  try {
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    }
  } catch {
    return undefined
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: loadHttps(),
  },
})
