type RestoreResult = {
  status: 'no_backup'
}

export async function checkAndRestoreITerm2Backup(): Promise<RestoreResult> {
  return { status: 'no_backup' }
}
