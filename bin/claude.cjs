#!/usr/bin/env node

(async () => {
  await import('../dist/cli.js')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
