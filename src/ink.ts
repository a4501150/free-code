import { createElement, type ReactNode } from 'react'
import { ThemeProvider } from './components/design-system/ThemeProvider.js'
import inkRender, {
  type Instance,
  createRoot as inkCreateRoot,
  type RenderOptions,
  type Root,
} from './ink/root.js'

export type { RenderOptions, Instance, Root }

// Wrap all CC render calls with ThemeProvider so ThemedBox/ThemedText work
// without every call site having to mount it. Ink itself is theme-agnostic.
function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return inkRender(withTheme(node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await inkCreateRoot(options)
  return {
    ...root,
    render: node => root.render(withTheme(node)),
  }
}

export { color } from './components/design-system/color.js'
export { default as Box } from './components/design-system/ThemedBox.js'
export type { Props as TextProps } from './components/design-system/ThemedText.js'
export { default as Text } from './components/design-system/ThemedText.js'
export {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from './components/design-system/ThemeProvider.js'
export { Ansi } from './ink/Ansi.js'
export { default as Link } from './ink/components/Link.js'
export { default as Newline } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { RawAnsi } from './ink/components/RawAnsi.js'
export { default as BaseText } from './ink/components/Text.js'
export type { DOMElement } from './ink/dom.js'
export { ClickEvent } from './ink/events/click-event.js'
export type { Key } from './ink/events/input-event.js'
export { InputEvent } from './ink/events/input-event.js'
export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { useTabStatus } from './ink/hooks/use-tab-status.js'
export { useTerminalFocus } from './ink/hooks/use-terminal-focus.js'
export { useTerminalTitle } from './ink/hooks/use-terminal-title.js'
export { default as measureElement } from './ink/measure-element.js'
export { default as wrapText } from './ink/wrap-text.js'
