/**
 * The client keeps imports from schema and gateway modules type-only, or zod
 * and Node modules leak into the bundle. CSP permits self/data images, not
 * blob URLs. Off-screen panels stay focusable and hit-testable unless they
 * also get `visibility: hidden` or zero height; mobile controls stay at least
 * 16px against iOS Safari focus zoom.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
