import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Start the monitor server as a side-car within the same Nitro process so
// docker-compose only needs one service and `npm run start` is enough.
export default defineNitroPlugin(() => {
  const port = Number(process.env.MONITOR_PORT || 3031)
  const host = process.env.MONITOR_HOST || '0.0.0.0'
  const allowedPaths = new Set(['/api/monitor/stats', '/api/monitor/models'])

  const htmlPath = join(process.cwd(), 'public', 'monitor.html')

  const monitorServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost`)

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/monitor.html')) {
        const html = await readFile(htmlPath, 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(html)
        return
      }

      if (req.method === 'GET' && allowedPaths.has(url.pathname)) {
        // Forward to the same Nitro process on localhost
        const nitroPort = Number(process.env.PORT || 3000)
        const upstream = await fetch(`http://127.0.0.1:${nitroPort}${url.pathname}${url.search}`, {
          signal: AbortSignal.timeout(10_000)
        })
        const body = Buffer.from(await upstream.arrayBuffer())
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        res.end(body)
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '监控服务暂时无法获取数据' }))
      console.error('[monitor] request failed:', err)
    }
  })

  monitorServer.listen(port, host, () => {
    console.log(`[monitor] Dashboard available at http://${host}:${port}`)
  })

  monitorServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[monitor] Port ${port} is already in use — monitor server not started`)
    } else {
      console.error('[monitor] Server error:', err)
    }
  })
})
