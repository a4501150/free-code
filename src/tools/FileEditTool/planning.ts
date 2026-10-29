// Input → planner-request flattening shared by FileEditTool's validateInput
// and call, the permission request's diff computation, and the rejection-diff
// renderer. One place owns the single-vs-batch mode rules so the three
// consumers cannot drift.

import {
  planEditBatch,
  type EditPlanRequest,
  type EditPlanResult,
} from '../../utils/editMatch.js'
import type { FileEditInput } from './types.js'

export type { EditPlanRequest, EditPlanResult }

export type RequestsOrInvalid =
  | { requests: EditPlanRequest[]; batch: boolean }
  | { invalid: string }

/** Batch mode: an edits[] array instead of the single-edit fields. */
export function isBatchInput(input: FileEditInput): boolean {
  return Array.isArray(input.edits)
}

/**
 * Flattens a parsed Edit input into planner requests, enforcing mode
 * exclusivity: either the single-edit fields (old_string + new_string,
 * optionally end_string/replace_all) or a non-empty edits array — never
 * both. Creation mode (old_string === '' against a missing file) is a
 * caller concern; this returns it as a single request like any other.
 */
export function editRequestsFromInput(input: FileEditInput): RequestsOrInvalid {
  const hasSingle =
    input.old_string !== undefined || input.new_string !== undefined

  if (Array.isArray(input.edits)) {
    if (hasSingle || input.end_string !== undefined || input.replace_all) {
      return {
        invalid:
          'Provide either a single edit (old_string/new_string) or the edits array, not both.',
      }
    }
    if (input.edits.length === 0) {
      return { invalid: 'The edits array is empty.' }
    }
    if (input._overrideContent) {
      return {
        invalid: 'Internal error: _overrideContent cannot combine with edits.',
      }
    }
    return {
      requests: input.edits.map(e => ({
        oldString: e.old_string,
        newString: e.new_string,
        replaceAll: e.replace_all ?? false,
        ...(e.end_string !== undefined && { endString: e.end_string }),
      })),
      batch: true,
    }
  }

  if (input.old_string === undefined || input.new_string === undefined) {
    return {
      invalid:
        'old_string and new_string are required when the edits array is not supplied.',
    }
  }
  if (input.end_string !== undefined && input.replace_all) {
    return {
      invalid:
        'replace_all cannot be combined with end_string (an anchor-range edit replaces exactly one span).',
    }
  }
  return {
    requests: [
      {
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: input.replace_all ?? false,
        ...(input.end_string !== undefined && {
          endString: input.end_string,
        }),
      },
    ],
    batch: false,
  }
}

/**
 * Plan the whole call (single or batch) against fileText. Mode errors
 * surface as an errorCode-1 failure so callers treat them like any other
 * validation failure.
 */
export function planInputAgainst(
  fileText: string,
  input: FileEditInput,
): EditPlanResult {
  const flattened = editRequestsFromInput(input)
  if ('invalid' in flattened) {
    return {
      ok: false,
      failure: { message: flattened.invalid, errorCode: 1 },
    }
  }
  return planEditBatch(fileText, flattened.requests)
}
