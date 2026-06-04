import { z } from 'zod/v4'
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskSchema = z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(), // present continuous form for spinner (e.g., "Running tests")
  owner: z.string().optional(), // agent ID
  status: TaskStatusSchema,
  blocks: z.array(z.string()), // task IDs this task blocks
  blockedBy: z.array(z.string()), // task IDs that block this task
  metadata: z.record(z.string(), z.unknown()).optional(), // arbitrary metadata
})
export type Task = z.infer<typeof TaskSchema>
