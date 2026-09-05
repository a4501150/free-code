import { normalize } from 'path'

/**
 * Response-local Edit bookkeeping: files this response has already edited.
 * The model writes every tool call in a response before seeing any result, so
 * a second Edit of the same file cites anchors minted before the first edit
 * landed — content the model can no longer see. Rather than remap anchors
 * through applied patches, the second Edit is rejected until a Read (or a
 * Write that authors the content fresh) re-baselines the file. Not
 * conversation state: the next response starts from the post-edit file, where
 * held anchors resolve by direct (hash-matching) validation.
 */
export class ResponseEditState {
  private edited = new Set<string>()

  markEdited(filePath: string): void {
    this.edited.add(normalize(filePath))
  }

  /** A Read or Write showed (or authored) current content: anchors are live. */
  clearEdited(filePath: string): void {
    this.edited.delete(normalize(filePath))
  }

  isEdited(filePath: string): boolean {
    return this.edited.has(normalize(filePath))
  }
}
