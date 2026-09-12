import { z } from 'zod/v4'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

const editFields = {
  file_path: z.string().describe('The absolute path to the file to modify'),
  old_string: z
    .string()
    .describe(
      'The exact text to replace, matching the file content verbatim including indentation. Strip any Read/Grep line-number prefix (`N:`) from copied lines — never include the prefix in this string.',
    ),
  new_string: z
    .string()
    .describe(
      'The text to replace it with (must be different from old_string). An empty string deletes the matched text.',
    ),
  replace_all: semanticBoolean(z.boolean().optional()).describe(
    'Replace all occurrences of old_string (default false)',
  ),
}

// Model-facing schema. _overrideContent is intentionally absent so the model
// cannot bypass match validation by supplying raw file content.
// Placement is content-anchored: there are deliberately no line-range
// parameters — disambiguation happens by extending old_string's context,
// which keeps the call shape minimal for structured-output models.
const inputSchema = z.strictObject(editFields)
type InputSchema = typeof inputSchema

// Full schema includes the internal _overrideContent field, set by the IDE-amend
// flow after the user edits the proposed diff in their editor.
const fullInputSchema = z.strictObject({
  ...editFields,
  _overrideContent: z
    .object({ newContent: z.string() })
    .optional()
    .describe('Internal: pre-computed full file content from an IDE amend.'),
})

// Parsed output — what call()/validateInput receive (includes _overrideContent).
export type FileEditInput = z.output<typeof fullInputSchema>

export const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
})

export const approvalNoteSchema = z.enum([
  'fresh',
  'recovered',
  'blind-placement',
  'blind',
])
export type ApprovalNoteValue = z.infer<typeof approvalNoteSchema>

// Output schema for FileEditTool
const outputSchema = z.object({
  filePath: z.string().describe('The file path that was edited'),
  originalFile: z
    .string()
    .describe('The original file contents before editing'),
  structuredPatch: z
    .array(hunkSchema)
    .describe('Diff patch showing the changes'),
  userModified: z
    .boolean()
    .describe('Whether the user modified the proposed changes'),
  editCount: z.number().describe('Number of replacements applied'),
  approvalNote: approvalNoteSchema
    .optional()
    .describe(
      'How placement was approved against the model\u2019s seen content',
    ),
})
type OutputSchema = typeof outputSchema

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, fullInputSchema, outputSchema }
export type { InputSchema }
