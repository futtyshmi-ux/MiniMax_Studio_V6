#!/usr/bin/env node
/**
 * MiniMax H3 Studio
 * Server entry point for Next.js 16.
 */
process.env.NODE_ENV = 'production'
process.env.NEXT_TELEMETRY_DISABLED = '1'

const http = require('http')
const next = require('next')

const dir = __dirname
// Default to loopback: binding 0.0.0.0 triggers a Windows Firewall prompt on
// fresh machines. Set BIND_HOST=0.0.0.0 to expose the UI on the LAN.
const hostname = process.env.BIND_HOST || '127.0.0.1'
const port = parseInt(process.env.PORT || '3000', 10)

// Handle uncaught exceptions gracefully (e.g. "Controller is already closed")
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message)
  console.error('Stack:', err.stack)
  // Don't exit — let the server keep running
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

async function start() {
  const app = next({
    dir,
    hostname,
    port,
    dev: false,
  })

  await app.prepare()

  const server = http.createServer((req, res) => {
    app.requestHandler(req, res)
  })

  server.listen(port, hostname, () => {
    console.log(`  Web UI:   http://localhost:${port}`)
    console.log(`  ComfyUI:  http://127.0.0.1:${process.env.COMFY_PORT || 8188}`)
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    server.close(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0))
  })
}

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
