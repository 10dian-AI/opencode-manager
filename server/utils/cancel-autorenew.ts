import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ScriptSubscription {
  id?: string | null
  status?: string | null
  cancel_at_period_end?: boolean
  current_period_end?: number | null
}

interface ScriptResult {
  success?: boolean
  message?: string
  already_cancelled?: boolean
  subscription?: ScriptSubscription | null
}

export interface AutorenewCancellationResult {
  alreadyCancelled: boolean
  currentPeriodEnd: string | null
  subscriptionId: string | null
}

function scriptPath() {
  const candidates = [
    process.env.CANCEL_AUTORENEW_SCRIPT_PATH,
    resolve(process.cwd(), 'server/utils/cancel_autorenew.py'),
    resolve(dirname(fileURLToPath(import.meta.url)), 'cancel_autorenew.py')
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find(path => existsSync(path))
  if (!found) {
    throw new Error('取消续费脚本未部署，请检查 server/utils/cancel_autorenew.py')
  }
  return found
}

function pythonExecutable() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3')
}

function periodEndFromUnix(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function runScript(payload: Record<string, unknown>, timeoutSeconds: number) {
  return new Promise<ScriptResult>((resolveResult, reject) => {
    const child = spawn(
      pythonExecutable(),
      [scriptPath(), '--stdin', '--action', 'cancel', '--timeout', String(timeoutSeconds)],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } }
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill()
      settled = true
      reject(new Error(`取消续费脚本执行超时（${timeoutSeconds} 秒）`))
    }, Math.max(1, timeoutSeconds) * 1000 + 10_000)

    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`启动取消续费脚本失败: ${error.message}`))
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
      const lastLine = lines.at(-1)
      let result: ScriptResult | null = null
      if (lastLine) {
        try {
          result = JSON.parse(lastLine) as ScriptResult
        } catch {
          // The script's --stdin mode is JSON-only; retain stderr for diagnostics.
        }
      }
      if (!result) {
        reject(new Error(stderr.trim() || stdout.trim() || `取消续费脚本退出码 ${code ?? 'unknown'}`))
        return
      }
      if (!result.success) {
        reject(new Error(result.message || stderr.trim() || '取消自动续费失败'))
        return
      }
      resolveResult(result)
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

/** Run the checked-in Python protocol script against an account's auth cookie. */
export async function cancelAutorenewWithScript(
  authCookie: string,
  workspaceId: string,
  timeoutSeconds = 30
): Promise<AutorenewCancellationResult> {
  const result = await runScript(
    { auth: authCookie, workspace_id: workspaceId },
    timeoutSeconds
  )
  return {
    alreadyCancelled: Boolean(result.already_cancelled),
    currentPeriodEnd: periodEndFromUnix(result.subscription?.current_period_end),
    subscriptionId: result.subscription?.id || null
  }
}
