type Props = {
  onProceed: (signal: AbortSignal) => Promise<void>
  onCancel: () => void
}
