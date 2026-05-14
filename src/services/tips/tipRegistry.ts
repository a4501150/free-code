import chalk from 'chalk'
import { fileHistoryEnabled } from 'src/utils/fileHistory.js'
import { getInitialSettings, getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { shouldOfferTerminalSetup } from '../../commands/terminalSetup/terminalSetup.js'
import { color } from '../../components/design-system/color.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { isKairosCronEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { is1PApiCustomer } from '../../utils/auth.js'
import { countConcurrentSessions } from '../../utils/concurrentSessions.js'
import {
  getDisplayedEffortLevel,
  modelSupportsEffort,
} from '../../utils/effort.js'
import { env } from '../../utils/env.js'
import { cacheKeys } from '../../utils/fileStateCache.js'
import { getWorktreeCount } from '../../utils/git.js'
import {
  detectRunningIDEsCached,
  getSortedIdeLockfiles,
  isCursorInstalled,
  isSupportedTerminal,
  isSupportedVSCodeTerminal,
  isVSCodeInstalled,
  isWindsurfInstalled,
} from '../../utils/ide.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getPlatform } from '../../utils/platform.js'
import { isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js'
import { loadKnownMarketplacesConfigSafe } from '../../utils/plugins/marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js'
import {
  getCurrentSessionAgentColor,
  isCustomTitleEnabled,
} from '../../utils/sessionStorage.js'
import type { Tip, TipContext } from './types.js'

let _isOfficialMarketplaceInstalledCache: boolean | undefined
async function isOfficialMarketplaceInstalled(): Promise<boolean> {
  if (_isOfficialMarketplaceInstalledCache !== undefined) {
    return _isOfficialMarketplaceInstalledCache
  }
  const config = await loadKnownMarketplacesConfigSafe()
  _isOfficialMarketplaceInstalledCache = OFFICIAL_MARKETPLACE_NAME in config
  return _isOfficialMarketplaceInstalledCache
}

async function isMarketplacePluginRelevant(
  pluginName: string,
  context: TipContext | undefined,
  signals: { filePath?: RegExp; cli?: string[] },
): Promise<boolean> {
  if (!(await isOfficialMarketplaceInstalled())) {
    return false
  }
  if (isPluginInstalled(`${pluginName}@${OFFICIAL_MARKETPLACE_NAME}`)) {
    return false
  }
  const { bashTools } = context ?? {}
  if (signals.cli && bashTools?.size) {
    if (signals.cli.some(cmd => bashTools.has(cmd))) {
      return true
    }
  }
  if (signals.filePath && context?.readFileState) {
    const readFiles = cacheKeys(context.readFileState)
    if (readFiles.some(fp => signals.filePath!.test(fp))) {
      return true
    }
  }
  return false
}

const externalTips: Tip[] = [
  {
    id: 'new-user-warmup',
    content: async () =>
      `Start with small features or bug fixes, tell Claude to propose a plan, and verify its suggested edits`,
    isRelevant: async () => true,
  },
  {
    id: 'plan-mode-for-complex-tasks',
    content: async () =>
      `Use Plan Mode to prepare for a complex request before making changes. Press ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} twice to enable.`,
    isRelevant: async () => true,
  },
  {
    id: 'default-permission-mode-config',
    content: async () =>
      `Use /config to change your default permission mode (including Plan Mode)`,
    isRelevant: async () => {
      const settings = getSettings_DEPRECATED()
      return !settings?.permissions?.defaultMode
    },
  },
  {
    id: 'git-worktrees',
    content: async () =>
      'Use git worktrees to run multiple Claude sessions in parallel.',
    isRelevant: async () => {
      try {
        const worktreeCount = await getWorktreeCount()
        return worktreeCount <= 1
      } catch (_) {
        return false
      }
    },
  },
  {
    id: 'color-when-multi-clauding',
    content: async () =>
      'Running multiple Claude sessions? Use /color and /rename to tell them apart at a glance.',
    isRelevant: async () => {
      if (getCurrentSessionAgentColor()) return false
      const count = await countConcurrentSessions()
      return count >= 2
    },
  },
  {
    id: 'terminal-setup',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? 'Run /terminal-setup to enable convenient terminal integration like Option + Enter for new line and more'
        : 'Run /terminal-setup to enable convenient terminal integration like Shift + Enter for new line and more',
    isRelevant: async () => shouldOfferTerminalSetup(),
  },
  {
    id: 'shift-enter',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? 'Press Option+Enter to send a multi-line message'
        : 'Press Shift+Enter to send a multi-line message',
    isRelevant: async () => true,
  },
  {
    id: 'theme-command',
    content: async () => 'Use /theme to change the color theme',
    isRelevant: async () => true,
  },
  {
    id: 'colorterm-truecolor',
    content: async () =>
      'Try setting environment variable COLORTERM=truecolor for richer colors',
    isRelevant: async () => !process.env.COLORTERM && chalk.level < 3,
  },
  {
    id: 'powershell-tool-env',
    content: async () =>
      'Set CLAUDE_CODE_USE_POWERSHELL_TOOL=1 to enable the PowerShell tool (preview)',
    isRelevant: async () =>
      getPlatform() === 'windows' &&
      process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL === undefined,
  },
  {
    id: 'status-line',
    content: async () =>
      'Use /statusline to set up a custom status line that will display beneath the input box',
    isRelevant: async () => getSettings_DEPRECATED().statusLine === undefined,
  },
  {
    id: 'prompt-queue',
    content: async () =>
      'Hit Enter to queue up additional messages while Claude is working.',
    isRelevant: async () => true,
  },
  {
    id: 'enter-to-steer-in-relatime',
    content: async () =>
      'Send messages to Claude while it works to steer Claude in real-time',
    isRelevant: async () => true,
  },
  {
    id: 'todo-list',
    content: async () =>
      'Ask Claude to create a todo list when working on complex tasks to track progress and remain on track',
    isRelevant: async () => true,
  },
  {
    id: 'vscode-command-install',
    content: async () =>
      `Open the Command Palette (Cmd+Shift+P) and run "Shell Command: Install '${env.terminal === 'vscode' ? 'code' : env.terminal}' command in PATH" to enable IDE integration`,
    async isRelevant() {
      if (!isSupportedVSCodeTerminal()) {
        return false
      }
      if (getPlatform() !== 'macos') {
        return false
      }
      switch (env.terminal) {
        case 'vscode':
          return !(await isVSCodeInstalled())
        case 'cursor':
          return !(await isCursorInstalled())
        case 'windsurf':
          return !(await isWindsurfInstalled())
        default:
          return false
      }
    },
  },
  {
    id: 'ide-upsell-external-terminal',
    content: async () => 'Connect Claude to your IDE · /ide',
    async isRelevant() {
      if (isSupportedTerminal()) {
        return false
      }
      const lockfiles = await getSortedIdeLockfiles()
      if (lockfiles.length !== 0) {
        return false
      }
      const runningIDEs = await detectRunningIDEsCached()
      return runningIDEs.length > 0
    },
  },
  {
    id: 'permissions',
    content: async () =>
      'Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools',
    isRelevant: async () => true,
  },
  {
    id: 'drag-and-drop-images',
    content: async () =>
      'Did you know you can drag and drop image files into your terminal?',
    isRelevant: async () => !env.isSSH(),
  },
  {
    id: 'paste-images-mac',
    content: async () =>
      'Paste images into Claude Code using control+v (not cmd+v!)',
    isRelevant: async () => getPlatform() === 'macos',
  },
  {
    id: 'double-esc',
    content: async () =>
      'Double-tap esc to rewind the conversation to a previous point in time',
    isRelevant: async () => !fileHistoryEnabled(),
  },
  {
    id: 'double-esc-code-restore',
    content: async () =>
      'Double-tap esc to rewind the code and/or conversation to a previous point in time',
    isRelevant: async () => fileHistoryEnabled(),
  },
  {
    id: 'continue',
    content: async () =>
      'Run claude --continue or claude --resume to resume a conversation',
    isRelevant: async () => true,
  },
  {
    id: 'rename-conversation',
    content: async () =>
      'Name your conversations with /rename to find them easily in /resume later',
    isRelevant: async () => isCustomTitleEnabled(),
  },
  {
    id: 'custom-commands',
    content: async () =>
      'Create skills by adding .md files to .claude/skills/ in your project or ~/.claude/skills/ for skills that work in any project',
    isRelevant: async () => true,
  },
  {
    id: 'shift-tab',
    content: async () =>
      `Hit ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} to cycle between default mode, auto-accept edit mode, and plan mode`,
    isRelevant: async () => true,
  },
  {
    id: 'image-paste',
    content: async () =>
      `Use ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} to paste images from your clipboard`,
    isRelevant: async () => true,
  },
  {
    id: 'custom-agents',
    content: async () =>
      'Use /agents to optimize specific tasks. Eg. Software Architect, Code Writer, Code Reviewer',
    isRelevant: async () => true,
  },
  {
    id: 'agent-flag',
    content: async () =>
      'Use --agent <agent_name> to directly start a conversation with a subagent',
    isRelevant: async () => true,
  },
  {
    id: 'desktop-app',
    content: async () =>
      'Run Claude Code locally or remotely using the Claude desktop app: clau.de/desktop',
    isRelevant: async () => getPlatform() !== 'linux',
  },
  {
    id: 'desktop-shortcut',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `Continue your session in Claude Code Desktop with ${blue('/desktop')}`
    },
    isRelevant: async () => false,
  },
  {
    id: 'web-app',
    content: async () =>
      'Run tasks in the cloud while you keep coding locally · clau.de/web',
    isRelevant: async () => true,
  },
  {
    id: 'mobile-app',
    content: async () =>
      '/mobile to use Claude Code from the Claude app on your phone',
    isRelevant: async () => true,
  },
  {
    id: 'frontend-design-plugin',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `Working with HTML/CSS? Install the frontend-design plugin:\n${blue(`/plugin install frontend-design@${OFFICIAL_MARKETPLACE_NAME}`)}`
    },
    isRelevant: async context =>
      isMarketplacePluginRelevant('frontend-design', context, {
        filePath: /\.(html|css|htm)$/i,
      }),
  },
  {
    id: 'vercel-plugin',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `Working with Vercel? Install the vercel plugin:\n${blue(`/plugin install vercel@${OFFICIAL_MARKETPLACE_NAME}`)}`
    },
    isRelevant: async context =>
      isMarketplacePluginRelevant('vercel', context, {
        filePath: /(?:^|[/\\])vercel\.json$/i,
        cli: ['vercel'],
      }),
  },
  {
    id: 'effort-high-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      const cmd = blue('/effort high')
      return `Working on something tricky? ${cmd} gives better first answers`
    },
    isRelevant: async () => {
      if (!is1PApiCustomer()) return false
      const model = getMainLoopModel()
      if (!modelSupportsEffort(model)) return false
      const displayed = getDisplayedEffortLevel(model)
      if (
        displayed === 'high' ||
        displayed === 'max' ||
        displayed === 'xhigh'
      ) {
        return false
      }
      return true
    },
  },
  {
    id: 'subagent-fanout-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `Say ${blue('"fan out subagents"')} and Claude sends a team. Each one digs deep so nothing gets missed.`
    },
    isRelevant: async () => is1PApiCustomer(),
  },
  {
    id: 'loop-command-nudge',
    content: async ctx => {
      const blue = color('suggestion', ctx.theme)
      return `${blue('/loop')} runs any prompt on a recurring schedule. Great for monitoring deploys, babysitting PRs, or polling status.`
    },
    isRelevant: async () => {
      if (!is1PApiCustomer()) return false
      if (!isKairosCronEnabled()) return false
      return true
    },
  },
]
const internalOnlyTips: Tip[] = []

function getCustomTips(): Tip[] {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  if (!override?.tips?.length) return []

  return override.tips.map((content, i) => ({
    id: `custom-tip-${i}`,
    content: async () => content,
    isRelevant: async () => true,
  }))
}

export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  const customTips = getCustomTips()

  if (override?.excludeDefault && customTips.length > 0) {
    return customTips
  }

  const tips = [...externalTips, ...internalOnlyTips]
  const isRelevant = await Promise.all(tips.map(_ => _.isRelevant(context)))
  const filtered = tips.filter((_, index) => isRelevant[index])

  return [...filtered, ...customTips]
}
