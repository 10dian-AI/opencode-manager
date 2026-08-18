import { describe, expect, test } from 'bun:test'
import { toggleChineseModels } from '../server/utils/opencode-chinese-models'

function settingsPage(enabled: boolean) {
  return `
    <html><body>
      <form action="/_server?id=${'a'.repeat(64)}">
        <input name="workspaceID" value="wrk_TEST">
        <input name="useChinaProviders" value="${enabled}">
      </form>
    </body></html>
  `
}

describe('Chinese model HTTP toggle', () => {
  test('uses the supplied account fetch implementation and verifies the target state', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let enabled = false
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (init?.method === 'POST') {
        enabled = true
        return new Response('', { status: 200 })
      }
      const response = new Response(settingsPage(enabled), { status: 200 })
      Object.defineProperty(response, 'url', {
        configurable: true,
        value: 'https://opencode.ai/workspace/wrk_TEST/go'
      })
      return response
    }) as typeof fetch

    await toggleChineseModels('raw-cookie', 'wrk_TEST', true, fetchImpl)

    expect(calls.length).toBe(3)
    expect(calls[0]!.init?.headers).toMatchObject({ cookie: 'auth=raw-cookie; oc_locale=zh' })
    expect(calls[1]!.init?.method).toBe('POST')
    expect(String(calls[1]!.init?.body)).toContain('useChinaProviders=false')
  })

  test('does not submit when the account is already in the target state', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      const response = new Response(settingsPage(true), { status: 200 })
      Object.defineProperty(response, 'url', {
        configurable: true,
        value: 'https://opencode.ai/workspace/wrk_TEST/go'
      })
      return response
    }) as typeof fetch

    await toggleChineseModels('raw-cookie', 'wrk_TEST', true, fetchImpl)
    expect(calls).toBe(1)
  })
})
