import { useEffect, useState } from 'react'

/**
 * Mermaid is deliberately lazy-loaded from a pinned CDN build: the whole
 * library (d3, dagre, elkjs) would triple the embedded bundle, and it is only
 * fetched when a transcript actually contains a closed mermaid fence.
 *
 * The URL is pinned to a version and typed `string` so the bundler keeps the
 * `import()` as a runtime import. Bun inlines dynamic imports whose specifier
 * is a literal, so a plain `import('https://…')` would be baked into the
 * bundle and blocked under the page CSP's `script-src` (the bundle's blob has
 * `source="bundled"`, with no separate URL for the CDN fetch to ride).
 *
 * The path must stay inside `dist/`: the ESM build pulls the real library
 * (mermaid.core.mjs, then diagram chunks) as siblings relative to it, so
 * every fetch rides the one CDN origin the gateway's CSP allows.
 */
const MERMAID_MODULE_URL: string =
  'https://cdn.jsdelivr.net/npm/mermaid@11.13.0/dist/mermaid.esm.min.mjs'

interface MermaidModule {
  initialize(config: Record<string, unknown>): void
  render(id: string, text: string): Promise<{ svg: string }>
}

let modulePromise: Promise<MermaidModule> | null = null

function loadMermaid(): Promise<MermaidModule> {
  if (!modulePromise) {
    modulePromise = import(MERMAID_MODULE_URL)
      .then(mod => {
        const mermaid = (mod as { default?: MermaidModule } & MermaidModule)
          .default
        if (!mermaid?.render) throw new Error('mermaid module missing export')
        mermaid.initialize({
          startOnLoad: false,
          // strict escapes labels and rejects click callbacks: the diagram
          // source is model output, and we inject the SVG without sanitizing.
          securityLevel: 'strict',
          theme: 'dark',
          flowchart: { useMaxWidth: true },
          sequence: { useMaxWidth: true },
        })
        return mermaid
      })
      .catch(err => {
        // Let a later diagram retry the fetch after a transient failure.
        modulePromise = null
        throw err
      })
  }
  return modulePromise
}

/** Rendered SVGs keyed by diagram source: streaming re-renders neither refetch nor re-layout. */
const svgCache = new Map<string, Promise<string>>()
let renderSeq = 0

function renderDiagram(source: string): Promise<string> {
  let svg = svgCache.get(source)
  if (!svg) {
    svg = loadMermaid().then(
      async mermaid =>
        (await mermaid.render(`mermaid-${++renderSeq}`, source)).svg,
    )
    svgCache.set(source, svg)
    svg.catch(() => svgCache.delete(source))
  }
  return svg
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'failed' }

export function Mermaid({ source }: { source: string }): React.ReactElement {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    renderDiagram(source).then(
      svg => active && setState({ status: 'ready', svg }),
      () => active && setState({ status: 'failed' }),
    )
    return () => {
      active = false
    }
  }, [source])

  if (state.status === 'ready') {
    return (
      <div
        className="md-mermaid"
        // mermaid itself renders with securityLevel: 'strict', which sanitizes
        // labels and strips click handlers. FilterXSS cannot be reused here:
        // its transcript allowlist has no svg/path/rect/g/text/marker entries.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }

  // Loading, offline (LAN with no internet), and parse errors all show the
  // original fence like any other code block. The hint names the reason when
  // we know it.
  return (
    <div className="md-mermaid md-mermaid--fallback">
      <div className="md-mermaid__hint">
        {state.status === 'loading'
          ? 'mermaid diagram…'
          : 'mermaid diagram — not rendered'}
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  )
}
