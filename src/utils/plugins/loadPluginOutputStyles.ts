import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { OutputStyleConfig } from '../../outputStyles/outputStyles.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import {
  coerceDescriptionToString,
  parseBooleanFrontmatter,
  parseFrontmatter,
} from '../frontmatterParser.js'
import { getFsImplementation, isDuplicatePath } from '../fsOperations.js'
import { extractDescriptionFromMarkdown } from '../markdownConfigLoader.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import { walkPluginMarkdown } from './walkPluginMarkdown.js'

async function loadOutputStylesFromDirectory(
  outputStylesPath: string,
  pluginName: string,
  loadedPaths: Set<string>,
): Promise<OutputStyleConfig[]> {
  const styles: OutputStyleConfig[] = []
  await walkPluginMarkdown(
    outputStylesPath,
    async (fullPath, namespace) => {
      const style = await loadOutputStyleFromFile(
        fullPath,
        pluginName,
        namespace,
        loadedPaths,
      )
      if (style) styles.push(style)
    },
    { logLabel: 'output-styles' },
  )
  return styles
}

async function loadOutputStyleFromFile(
  filePath: string,
  pluginName: string,
  namespace: string[],
  loadedPaths: Set<string>,
): Promise<OutputStyleConfig | null> {
  const fs = getFsImplementation()
  if (isDuplicatePath(fs, filePath, loadedPaths)) {
    return null
  }
  try {
    const content = await fs.readFile(filePath, { encoding: 'utf-8' })
    const { frontmatter, content: markdownContent } = parseFrontmatter(
      content,
      filePath,
    )

    const rawName = frontmatter.name
    const baseName =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim()
        : basename(filePath, '.md')
    // Namespaced like plugin commands and agents
    const name = [pluginName, ...namespace, baseName].join(':')

    if (name.includes('\n') || name.length > 100) {
      logForDebugging(`Skipping output style '${filePath}': invalid name`, {
        level: 'warn',
      })
      return null
    }

    // Deliberately no ${CLAUDE_PLUGIN_ROOT} substitution, unlike plugin agents:
    // an absolute path in the prompt would fragment the cached system prefix.
    const prompt = markdownContent.trim()
    if (!prompt) {
      logForDebugging(`Skipping output style '${filePath}': empty body`, {
        level: 'warn',
      })
      return null
    }

    return {
      name,
      description:
        coerceDescriptionToString(frontmatter.description, name) ??
        extractDescriptionFromMarkdown(
          prompt,
          `Output style from ${pluginName} plugin`,
        ),
      prompt,
      source: 'plugin',
      keepCodingInstructions: parseBooleanFrontmatter(
        frontmatter['keep-coding-instructions'],
      ),
      keepResponseStyle: parseBooleanFrontmatter(
        frontmatter['keep-response-style'],
      ),
      forceForPlugin: parseBooleanFrontmatter(frontmatter['force-for-plugin']),
    }
  } catch (error) {
    logForDebugging(`Failed to load output style from ${filePath}: ${error}`, {
      level: 'error',
    })
    return null
  }
}

export const loadPluginOutputStyles = memoize(
  async (): Promise<OutputStyleConfig[]> => {
    const { enabled, errors } = await loadAllPluginsCacheOnly()

    if (errors.length > 0) {
      logForDebugging(
        `Plugin loading errors: ${errors.map(e => getPluginErrorMessage(e)).join(', ')}`,
      )
    }

    const perPluginStyles = await Promise.all(
      enabled.map(async (plugin): Promise<OutputStyleConfig[]> => {
        // Track loaded file paths to prevent duplicates within this plugin
        const loadedPaths = new Set<string>()
        const pluginStyles: OutputStyleConfig[] = []

        // The conventional directory is scanned first so a manifest path wins
        // on a same-name collision within one plugin.
        if (plugin.outputStylesPath) {
          try {
            pluginStyles.push(
              ...(await loadOutputStylesFromDirectory(
                plugin.outputStylesPath,
                plugin.name,
                loadedPaths,
              )),
            )
          } catch (error) {
            logForDebugging(
              `Failed to load output styles from plugin ${plugin.name} default directory: ${error}`,
              { level: 'error' },
            )
          }
        }

        for (const stylePath of plugin.outputStylesPaths ?? []) {
          try {
            const fs = getFsImplementation()
            const stats = await fs.stat(stylePath)

            if (stats.isDirectory()) {
              pluginStyles.push(
                ...(await loadOutputStylesFromDirectory(
                  stylePath,
                  plugin.name,
                  loadedPaths,
                )),
              )
            } else if (stats.isFile() && stylePath.endsWith('.md')) {
              const style = await loadOutputStyleFromFile(
                stylePath,
                plugin.name,
                [],
                loadedPaths,
              )
              if (style) pluginStyles.push(style)
            }
          } catch (error) {
            logForDebugging(
              `Failed to load output styles from plugin ${plugin.name} custom path ${stylePath}: ${error}`,
              { level: 'error' },
            )
          }
        }

        return pluginStyles
      }),
    )

    const allStyles = perPluginStyles.flat()
    logForDebugging(`Total plugin output styles loaded: ${allStyles.length}`)
    return allStyles
  },
)

export function clearPluginOutputStyleCache(): void {
  loadPluginOutputStyles.cache?.clear?.()
}
