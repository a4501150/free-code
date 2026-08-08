import { parseSource, type TsNode } from './bashParser.js'

export type Node = TsNode

export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

const DECLARATION_COMMANDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'unsetenv',
])
const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number'])
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution',
])
const COMMAND_TYPES = new Set(['command', 'declaration_command'])

/**
 * Parse a command and locate its first command node plus leading env vars.
 *
 * Returns null for empty input or a parser bug. There is no fallback parser,
 * so null is fail-closed: security callers must treat it as 'too-complex'.
 */
export function parseCommand(command: string): ParsedCommandData | null {
  if (!command) return null
  const rootNode = parseSource(command)
  if (!rootNode) return null

  const commandNode = findCommandNode(rootNode, null)
  const envVars = extractEnvVars(commandNode)

  return { rootNode, envVars, commandNode, originalCommand: command }
}

/**
 * Raw parse — skips findCommandNode/extractEnvVars, which the security walker
 * in ast.ts doesn't use. Saves one tree walk per bash command.
 */
export function parseCommandRaw(command: string): Node | null {
  if (!command) return null
  return parseSource(command)
}

function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node

  if (COMMAND_TYPES.has(type)) return node

  // Variable assignment followed by command
  if (type === 'variable_assignment' && parent) {
    return (
      parent.children.find(
        c => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex,
      ) ?? null
    )
  }

  // Pipeline: recurse into first child (which may be a redirected_statement)
  if (type === 'pipeline') {
    for (const child of children) {
      const result = findCommandNode(child, node)
      if (result) return result
    }
    return null
  }

  // Redirected statement: find the command inside
  if (type === 'redirected_statement') {
    return children.find(c => COMMAND_TYPES.has(c.type)) ?? null
  }

  // Recursive search
  for (const child of children) {
    const result = findCommandNode(child, node)
    if (result) return result
  }

  return null
}

function extractEnvVars(commandNode: Node | null): string[] {
  if (!commandNode || commandNode.type !== 'command') return []

  const envVars: string[] = []
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') {
      envVars.push(child.text)
    } else if (child.type === 'command_name' || child.type === 'word') {
      break
    }
  }
  return envVars
}

export function extractCommandArguments(commandNode: Node): string[] {
  // Declaration commands
  if (commandNode.type === 'declaration_command') {
    const firstChild = commandNode.children[0]
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : []
  }

  const args: string[] = []
  let foundCommandName = false

  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') continue

    // Command name
    if (
      child.type === 'command_name' ||
      (!foundCommandName && child.type === 'word')
    ) {
      foundCommandName = true
      args.push(child.text)
      continue
    }

    // Arguments
    if (ARGUMENT_TYPES.has(child.type)) {
      args.push(stripQuotes(child.text))
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      break
    }
  }
  return args
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text
}
