import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const directory = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.MONITOR_PORT || 3031)
const host = process.env.MONITOR_HOST || '0.0.0.0'
const apiBase = (process.env.MONITOR_API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '')
const allowedApiPaths = new Set(['/api/monitor/stats', '/api/monitor/models'])

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/monitor.html')) {
      const html = await readFile(join(directory, 'public', 'monitor.html'), 'utf8')
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache'
      })
      response.end(html)
      return
    }

    if (request.method === 'GET' && allowedApiPaths.has(url.pathname)) {
      const upstream = await fetch(`${apiBase}${url.pathname}${url.search}`, {
        signal: AbortSignal.timeout(10_000)
      })
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(Buffer.from(await upstream.arrayBuffer()))
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: '监控服务暂时无法连接主应用' }))
    console.error('Monitor request failed:', error)
  }
})

server.listen(port, host, () => {
  console.log(`Monitor dashboard running on http://${host}:${port}`)
})
