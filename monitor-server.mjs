import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = 3031

app.get('/', (req, res) => {
  const htmlPath = join(__dirname, '../public/monitor.html')
  const html = readFileSync(htmlPath, 'utf-8')
  res.setHeader('Content-Type', 'text/html')
  res.send(html)
})

const server = createServer(app)

server.listen(PORT, () => {
  console.log(`📊 Monitor dashboard running on http://localhost:${PORT}`)
})
