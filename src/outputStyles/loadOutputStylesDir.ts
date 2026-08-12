import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import { logForDebugging } from '../utils/debug.js'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
} from '../utils/frontmatterParser.js'
import {
  extractDescriptionFromMarkdown,
  loadMarkdownFilesForSubdir,
} from '../utils/markdownConfigLoader.js'
import {
  RESERVED_OUTPUT_STYLE_NAMES,
  type OutputStyleConfig,
} from './outputStyles.js'

/**
 * Output styles defined as markdown in `output-styles` config directories: the
 * filename (or a `name` in frontmatter) is the style name, the body is the
 * prompt. Sources come from the shared loader, so `.claude` and `.freecode`,
 * parent directories and worktree fallback are all already handled.
 */
export const getOutputStyleDirStyles = memoize(
  async (cwd: string): Promise<OutputStyleConfig[]> => {
    const files = await loadMarkdownFilesForSubdir('output-styles', cwd)
    const styles: OutputStyleConfig[] = []

    for (const { filePath, frontmatter, content, source } of files) {
      const rawName = frontmatter['name']
      const name =
        typeof rawName === 'string' && rawName.trim()
          ? rawName.trim()
          : basename(filePath, '.md')

      if (RESERVED_OUTPUT_STYLE_NAMES.has(name)) {
        logForDebugging(
          `Skipping output style '${filePath}': '${name}' is a reserved name`,
          { level: 'warn' },
        )
        continue
      }
      // The name goes into a markdown heading in the system prompt.
      if (name.includes('\n') || name.length > 100) {
        logForDebugging(`Skipping output style '${filePath}': invalid name`, {
          level: 'warn',
        })
        continue
      }

      const prompt = content.trim()
      if (!prompt) {
        logForDebugging(`Skipping output style '${filePath}': empty body`, {
          level: 'warn',
        })
        continue
      }

      styles.push({
        name,
        description:
          coerceDescriptionToString(frontmatter['description'], name) ??
          extractDescriptionFromMarkdown(prompt, `Custom ${name} output style`),
        prompt,
        source,
        keepCodingInstructions: parseBooleanFrontmatter(
          frontmatter['keep-coding-instructions'],
        ),
        keepResponseStyle: parseBooleanFrontmatter(
          frontmatter['keep-response-style'],
        ),
      })
    }

    return styles
  },
)
