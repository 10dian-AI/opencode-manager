import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const PYTHON_SCRIPT = resolve(
  process.argv[1] ? process.argv[1] : process.cwd(),
  '../utils/china_models_http.py'
)

// Fallback paths for different environments
const SCRIPT_CANDIDATES = [
  PYTHON_SCRIPT,
  resolve(process.cwd(), 'server/utils/china_models_http.py'),
  resolve(process.cwd(), 'utils/china_models_http.py'),
  '/app/server/utils/china_models_http.py'
]

function findScript(): string {
  const { existsSync } = require('node:fs')
  for (const candidate of SCRIPT_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return SCRIPT_CANDIDATES[0]!
}

interface PythonResult {
  success: boolean
  already_enabled?: boolean
  message: string
}

/**
 * Call china_models_http.py via stdin JSON.
 * The script reads cookie_data from stdin when --stdin flag is passed.
 */
function callPythonScript(
  authCookie: string,
  workspaceUrl: string,
  timeoutMs = 60_000
): Promise<PythonResult> {
  return new Promise((resolve_fn, reject) => {
    const cookieData = {
      url: workspaceUrl,
      cookies: [{ name: 'auth', value: authCookie }]
    }

    const script = findScript()
    const proc = spawn('python3', [script, '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (err) => {
      reject(new Error(`无法启动 Python 脚本: ${err.message}`))
    })

    proc.on('close', (code) => {
      // Parse last line as JSON result
      const lines = stdout.trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim()
        if (line.startsWith('{')) {
          try {
            resolve_fn(JSON.parse(line) as PythonResult)
            return
          } catch {
            // not json, continue
          }
        }
      }
      // Fallback: check if stderr indicates python not found
      if (code !== 0 && stderr.includes('No such file')) {
        reject(new Error(`Python 脚本未找到: ${script}`))
        return
      }
      // Return a parsed result based on exit code
      resolve_fn({
        success: code === 0,
        message: stdout.trim() || stderr.trim() || `脚本退出码 ${code}`
      })
    })

    // Write cookie data as JSON to stdin
    proc.stdin.write(JSON.stringify(cookieData))
    proc.stdin.end()
  })
}

export async function toggleChineseModels(
  authCookie: string,
  workspaceId: string,
  enable: boolean,
  fetchImpl?: typeof fetch
): Promise<void> {
  const workspaceUrl = `https://opencode.ai/workspace/${workspaceId}/go`
  const result = await callPythonScript(authCookie, workspaceUrl)

  if (!result.success) {
    throw new Error(result.message || '中国模型操作失败')
  }

  // If already in desired state, that is success
  if (result.already_enabled && enable) return
  if (!result.already_enabled && !enable) return
}

// Keep these exports so bulk-action code still compiles
export async function enableAccountChineseModelsPy(
  authCookie: string,
  workspaceId: string
): Promise<void> {
  const workspaceUrl = `https://opencode.ai/workspace/${workspaceId}/go`
  const result = await callPythonScript(authCookie, workspaceUrl)
  if (!result.success) {
    throw new Error(result.message || '中国模型开启失败')
  }
}
