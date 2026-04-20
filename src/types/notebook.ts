/**
 * Subset of the Jupyter `.ipynb` notebook schema that the NotebookEdit /
 * notebook-reading code path cares about. Shapes are derived from the
 * consumer at src/utils/notebook.ts.
 */

export type NotebookCellType = 'code' | 'markdown' | 'raw'

export type NotebookOutputImage = {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

/**
 * Raw output block as stored in the `.ipynb` JSON. Discriminated by
 * `output_type` — the processor in notebook.ts handles every case listed
 * below.
 */
export type NotebookCellOutput =
  | {
      output_type: 'stream'
      name?: 'stdout' | 'stderr'
      text?: string | string[]
    }
  | {
      output_type: 'execute_result'
      data?: Record<string, unknown>
      metadata?: Record<string, unknown>
      execution_count?: number | null
    }
  | {
      output_type: 'display_data'
      data?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }
  | {
      output_type: 'error'
      ename: string
      evalue: string
      traceback: string[]
    }

/**
 * Raw cell as stored in the `.ipynb` JSON.
 */
export type NotebookCell = {
  cell_type: NotebookCellType
  source: string | string[]
  id?: string
  execution_count?: number | null
  outputs?: NotebookCellOutput[]
  metadata?: Record<string, unknown>
}

/**
 * Top-level `.ipynb` document shape we rely on.
 */
export type NotebookContent = {
  cells: NotebookCell[]
  metadata: {
    language_info?: { name?: string }
    [key: string]: unknown
  }
  nbformat?: number
  nbformat_minor?: number
}

/**
 * Post-processed output as produced by src/utils/notebook.ts for tool
 * results. Text is the human-readable form; image is the first image
 * pulled out of the output's `data` map, if any.
 */
export type NotebookCellSourceOutput = {
  output_type: NotebookCellOutput['output_type']
  text?: string
  image?: NotebookOutputImage
}

/**
 * Post-processed cell, carrying just the fields the tool output needs.
 */
export type NotebookCellSource = {
  cellType: NotebookCellType
  source: string
  cell_id: string
  language?: string
  execution_count?: number
  outputs?: NotebookCellSourceOutput[]
}
