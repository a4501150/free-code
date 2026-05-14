import type { ThemeName } from 'src/utils/theme.js'
import type { FileStateCache } from 'src/utils/fileStateCache.js'

export type TipContext = {
  bashTools?: Set<string>
  readFileState?: FileStateCache
}

export type TipRenderContext = {
  theme: ThemeName
}

export type Tip = {
  id: string
  content: (ctx: TipRenderContext) => Promise<string>
  isRelevant: (context?: TipContext) => Promise<boolean>
}
