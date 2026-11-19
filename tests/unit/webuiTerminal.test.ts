/**
 * Bundle + CSP guards for the interactive-task terminal. xterm.js must
 * arrive as a runtime fetch of pinned CDN URLs (a static import would blow
 * the embedded bundle budget — mermaid/KaTeX precedent), and the gateway
 * must let that origin through for both scripts and the xterm stylesheet.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '../..')

describe('terminal lazy-load wiring', () => {
  const assetsPath = join(ROOT, 'src/webui/generated/assets.ts')

  test('the built bundle keeps the xterm CDN imports as runtime URLs', () => {
    // A fresh checkout with no WEBUI build has no generated module.
    if (!existsSync(assetsPath)) return
    const js = readFileSync(assetsPath, 'utf8')
    expect(js).toContain('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm')
    expect(js).toContain(
      'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm',
    )
    // xterm itself must not be inlined — it is far over the bundle budget.
    expect(js).not.toContain('_core_coreService')
  })

  test('the gateway CSP allows the pinned CDN for scripts and styles', () => {
    const gateway = readFileSync(
      join(ROOT, 'src/webui/gateway/gatewayServer.ts'),
      'utf8',
    )
    expect(gateway).toContain(`"script-src 'self' https://cdn.jsdelivr.net"`)
    // xterm.css loads from the same origin the mermaid SVG <style> and the
    // KaTeX stylesheet already use.
    expect(gateway).toContain(
      `"style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"`,
    )
  })
})
