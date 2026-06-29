import { z } from 'zod/v4'

const editOp = z.object({
  op: z
    .enum(['replace', 'insert_after', 'delete'])
    .describe('The edit operation to perform.'),
  start: z
    .string()
    .describe(
      'Start anchor "LINE:HASH" copied from Read output (e.g. "12:a3f"). Use "0" to insert at the top.',
    ),
  end: z
    .string()
    .optional()
    .describe(
      'End anchor "LINE:HASH" for a multi-line replace/delete; defaults to start.',
    ),
  lines: z
    .string()
    .optional()
    .describe(
      'Replacement/inserted text (newline-separated). Required for replace/insert_after; omit for delete.',
    ),
})

export type EditOp = z.output<typeof editOp>

const refineEdits = (v: { edits: EditOp[] }, ctx: z.RefinementCtx): void => {
  v.edits.forEach((e, i) => {
    if (
      (e.op === 'replace' || e.op === 'insert_after') &&
      e.lines === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `edits[${i}]: "${e.op}" requires "lines" (the new text).`,
        path: ['edits', i, 'lines'],
      })
    }
  })
}

const editFields = {
  file_path: z.string().describe('The absolute path to the file to modify'),
  edits: z
    .array(editOp)
    .min(1)
    .describe('Edits to apply, referenced by LINE:HASH anchors.'),
}

// Model-facing schema. _overrideContent is intentionally absent so the model
// cannot bypass anchor validation by supplying raw file content.
const inputSchema = z.strictObject(editFields).superRefine(refineEdits)
type InputSchema = typeof inputSchema

// Full schema includes the internal _overrideContent field, set by the IDE-amend
// flow after the user edits the proposed diff in their editor.
const fullInputSchema = z
  .strictObject({
    ...editFields,
    _overrideContent: z
      .object({ newContent: z.string() })
      .optional()
      .describe('Internal: pre-computed full file content from an IDE amend.'),
  })
  .superRefine(refineEdits)

// Parsed output — what call()/validateInput receive (includes _overrideContent).
export type FileEditInput = z.output<typeof fullInputSchema>

export const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
})

export const gitDiffSchema = z.object({
  filename: z.string(),
  status: z.enum(['modified', 'added']),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.string(),
  repository: z
    .string()
    .nullable()
    .optional()
    .describe('GitHub owner/repo when available'),
})

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
  editCount: z.number().describe('Number of edits applied'),
  gitDiff: gitDiffSchema.optional(),
})
type OutputSchema = typeof outputSchema

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, fullInputSchema, outputSchema }
export type { InputSchema }
