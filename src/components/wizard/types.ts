import type { ComponentType, ReactNode } from 'react'

/**
 * A wizard step is a React component rendered by WizardProvider when the
 * user is on that step. No props are passed — the step reads wizard
 * state via useWizard().
 */
export type WizardStepComponent<
  T extends Record<string, unknown> = Record<string, unknown>,
> = ComponentType<Record<string, never>>

/**
 * Shape of the context exposed to steps. `T` is the wizard's accumulated
 * data blob.
 */
export type WizardContextValue<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  currentStepIndex: number
  totalSteps: number
  wizardData: T
  setWizardData: React.Dispatch<React.SetStateAction<T>>
  updateWizardData: (updates: Partial<T>) => void
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  title?: string
  showStepCounter?: boolean
}

/**
 * Props accepted by `<WizardProvider>`. Steps are rendered sequentially
 * (in array order), but a step may call `goToStep()` to jump.
 */
export type WizardProviderProps<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  steps: WizardStepComponent<T>[]
  initialData?: T
  onComplete: (data: T) => void | Promise<void>
  onCancel?: () => void
  children?: ReactNode
  title?: string
  showStepCounter?: boolean
}
