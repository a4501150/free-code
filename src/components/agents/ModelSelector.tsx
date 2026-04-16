import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { getProviderRegistry } from '../../utils/model/providerRegistry.js'
import { Select } from '../CustomSelect/select.js'

interface ModelSelectorProps {
  initialModel?: string
  onComplete: (model?: string) => void
  onCancel?: () => void
}

export function ModelSelector({
  initialModel,
  onComplete,
  onCancel,
}: ModelSelectorProps): React.ReactNode {
  const modelOptions = React.useMemo(() => {
    const registry = getProviderRegistry()
    const allModels = registry.getAllModels()
    const options = allModels.map(({ providerName, model }) => ({
      value: `${providerName}:${model.id}`,
      label: model.label || model.id,
      description: model.description || model.id,
    }))
    // Add inherit option
    options.push({
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    })
    // If the agent's current model is not in the list, inject it
    if (initialModel && !options.some(o => o.value === initialModel)) {
      options.unshift({
        value: initialModel,
        label: initialModel,
        description: 'Current model (custom ID)',
      })
    }
    return options
  }, [initialModel])

  const defaultModel = initialModel ?? 'inherit'

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          Model determines the agent&apos;s reasoning capabilities and speed.
        </Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={onComplete}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  )
}
