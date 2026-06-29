import type { ToolInput } from './useFilePermissionDialog.js'

export interface IDEDiffConfig {
  filePath: string
  oldContent: string
  newContent: string
  editMode?: 'single' | 'multiple'
}

export interface IDEDiffChangeInput {
  file_path: string
  newContent: string
}

export interface IDEDiffSupport<TInput extends ToolInput> {
  getConfig(input: TInput): IDEDiffConfig
  applyChanges(input: TInput, newContent: string): TInput
}

export function createContentDiffConfig(
  filePath: string,
  oldContent: string,
  newContent: string,
  editMode: 'single' | 'multiple' = 'single',
): IDEDiffConfig {
  return { filePath, oldContent, newContent, editMode }
}
