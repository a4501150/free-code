// Input → planner-request mapping shared by FileEditTool's validateInput and
// call, the permission request's diff computation, and the rejection-diff
// renderer. One place owns the single-request shape so the consumers cannot
// drift.

import {
  planEdit,
  type EditPlanRequest,
  type EditPlanResult,
} from '../../utils/editMatch.js'
import type { FileEditInput } from './types.js'

export type { EditPlanRequest, EditPlanResult }

export type EditRequestOrInvalid =
  | { request: EditPlanRequest }
  | { invalid: string }

/**
 * Maps a parsed Edit input into its planner request. Creation mode
 * (old_string === '' against a missing file) is a caller concern; this
 * returns it as a request like any other.
 */
export function editRequestFromInput(
  input: FileEditInput,
): EditRequestOrInvalid {
  if (input.old_string === undefined || input.new_string === undefined) {
    return {
      invalid: 'old_string and new_string are required.',
    }
  }
  return {
    request: {
      oldString: input.old_string,
      newString: input.new_string,
      replaceAll: input.replace_all ?? false,
    },
  }
}

/**
 * Plan the call against fileText. Mode errors surface as an errorCode-1
 * failure so callers treat them like any other validation failure.
 */
export function planInputAgainst(
  fileText: string,
  input: FileEditInput,
): EditPlanResult {
  const mapped = editRequestFromInput(input)
  if ('invalid' in mapped) {
    return {
      ok: false,
      failure: { message: mapped.invalid, errorCode: 1 },
    }
  }
  return planEdit(fileText, mapped.request)
}
