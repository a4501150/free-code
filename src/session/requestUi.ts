/**
 * The rich `ui` half of a permission request, built for the tools whose
 * dialog is more than allow/deny. Both ask sites that open a broker request
 * — the REPL's interactive handler and the headless/hosted bridge — tag the
 * request with this, so every surface (terminal viewer, browser, remote
 * attach) can mount the tool's classic dialog instead of a generic prompt.
 *
 * Everything here is derived from the session's own scope (callers run
 * inside it), so the plan a remote surface sees is the one THIS session is
 * planning. Readers that ignore `ui` fall back to the generic prompt.
 */
import { AskUserQuestionTool } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { ExitPlanModeTool } from '../tools/ExitPlanModeTool/ExitPlanModeTool.js'
import { getPlan, getPlanFilePath } from '../utils/plans.js'
import type { WireQuestion, WireRequest } from './wire.js'

export function buildRequestUi(
  toolName: string,
  input: Record<string, unknown>,
): Extract<WireRequest, { kind: 'permission' }>['ui'] {
  if (toolName === AskUserQuestionTool.name) {
    const questions = (input as { questions?: unknown }).questions
    if (Array.isArray(questions) && questions.length > 0) {
      // The tool's own question shape is the wire's question shape.
      return { kind: 'question', questions: questions as WireQuestion[] }
    }
    return undefined
  }
  if (toolName === ExitPlanModeTool.name) {
    return {
      kind: 'plan',
      planFilePath: getPlanFilePath(),
      planContent: getPlan() ?? '',
    }
  }
  return undefined
}
