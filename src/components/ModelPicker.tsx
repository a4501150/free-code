import capitalize from 'lodash-es/capitalize.js'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useExitOnCtrlCDWithKeybindings } from 'src/hooks/useExitOnCtrlCDWithKeybindings.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
} from 'src/utils/fastMode.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  convertEffortValueToLevel,
  type EffortLevel,
  getDefaultEffortForModel,
  getModelEffortLevels,
  modelSupportsEffort,
  resolvePickerEffortPersistence,
  toPersistableEffort,
} from '../utils/effort.js'
import {
  getDefaultMainLoopModel,
  type ModelSetting,
  modelDisplayString,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getGroupedModelOptions,
  type ModelOptionGroup,
} from '../utils/model/modelOptions.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { updateProviderModelConfig } from '../utils/settings/freecodeSettings.js'
import { getProviderRegistry, resetProviderRegistry } from '../utils/model/providerRegistry.js'
import { parseModelString } from '../utils/model/parseModelString.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/index.js'
import { Byline } from './design-system/Byline.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Pane } from './design-system/Pane.js'
import { Tab, Tabs, useTabHeaderFocus } from './design-system/Tabs.js'
import { effortLevelToSymbol } from './EffortIndicator.js'

export type Props = {
  initial: string | null
  sessionModel?: ModelSetting
  onSelect: (model: string | null, effort: EffortLevel | undefined) => void
  onCancel?: () => void
  isStandaloneCommand?: boolean
  showFastModeNotice?: boolean
  /** Overrides the dim header line below "Select model". */
  headerText?: string
  /**
   * When true, skip writing effortLevel to userSettings on selection.
   * Used by the assistant installer wizard where the model choice is
   * project-scoped (written to the assistant's .claude/freecode.json via
   * install.ts) and should not leak to the user's global ~/.claude/settings.
   */
  skipSettingsWrite?: boolean
}

const NO_PREFERENCE = '__NO_PREFERENCE__'

type SelectOption = {
  value: string
  label: string
  description: string
  descriptionForModel?: string
}

export function ModelPicker({
  initial,
  sessionModel,
  onSelect,
  onCancel,
  isStandaloneCommand,
  showFastModeNotice,
  headerText,
  skipSettingsWrite,
}: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const exitState = useExitOnCtrlCDWithKeybindings()
  const maxVisible = 10

  const initialValue = initial === null ? NO_PREFERENCE : initial

  const isFastMode = useAppState(s =>
    isFastModeEnabled() ? s.fastMode : false,
  )

  const [hasToggledEffort, setHasToggledEffort] = useState(false)
  const effortValue = useAppState(s => s.effortValue)
  const [effort, setEffort] = useState<EffortLevel | undefined>(
    effortValue !== undefined
      ? convertEffortValueToLevel(effortValue)
      : undefined,
  )

  // Get model options grouped by provider
  const groups = useMemo(
    () => getGroupedModelOptions(isFastMode ?? false),
    [isFastMode],
  )

  // Build per-group select options (with NO_PREFERENCE sentinel for null values)
  const groupSelectOptions = useMemo(() => {
    return groups.map(group => {
      let opts = group.options.map(opt => ({
        ...opt,
        value: opt.value === null ? NO_PREFERENCE : (opt.value as string),
      }))

      // Ensure the initial value is in the appropriate group
      if (
        initial !== null &&
        !opts.some(opt => opt.value === initialValue) &&
        // Only add to the first group that might own it, or the first group as fallback
        group === groups[0]
      ) {
        const allOpts = groups.flatMap(g =>
          g.options.map(o => (o.value === null ? NO_PREFERENCE : o.value)),
        )
        if (!allOpts.includes(initialValue)) {
          opts = [
            ...opts,
            {
              value: initialValue,
              label: modelDisplayString(initial),
              description: 'Current model',
            },
          ]
        }
      }

      return opts
    })
  }, [groups, initial, initialValue])

  // Determine which tab the initial value belongs to
  const initialTabIndex = useMemo(() => {
    for (let i = 0; i < groupSelectOptions.length; i++) {
      if (groupSelectOptions[i]!.some(o => o.value === initialValue)) {
        return i
      }
    }
    return 0
  }, [groupSelectOptions, initialValue])

  const [activeTabIndex, setActiveTabIndex] = useState(initialTabIndex)
  const hasMultipleGroups = groups.length > 1

  // Track focused value — use a single state since only one tab's Select is active
  const [focusedValue, setFocusedValue] = useState<string | undefined>(
    initialValue,
  )

  // Find the focused option label across all groups
  const focusedModelName = useMemo(() => {
    for (const opts of groupSelectOptions) {
      const found = opts.find(opt => opt.value === focusedValue)
      if (found) return found.label
    }
    return undefined
  }, [groupSelectOptions, focusedValue])

  const focusedModel = resolveOptionModel(focusedValue)
  const focusedSupportsEffort = focusedModel
    ? modelSupportsEffort(focusedModel)
    : false
  const focusedEffortLevels = focusedModel
    ? getModelEffortLevels(focusedModel)
    : ['low', 'medium', 'high']
  const focusedDefaultEffort = getDefaultEffortLevelForOption(focusedValue)
  // Clamp display when effort is not in the focused model's supported levels
  const displayEffort =
    effort && !focusedEffortLevels.includes(effort)
      ? (focusedEffortLevels[focusedEffortLevels.length - 1] as EffortLevel)
      : effort

  const handleFocus = useCallback(
    (value: string) => {
      setFocusedValue(value)
      if (!hasToggledEffort && effortValue === undefined) {
        setEffort(getDefaultEffortLevelForOption(value))
      }
    },
    [hasToggledEffort, effortValue],
  )

  const handleCycleEffort = useCallback(
    (direction: 'left' | 'right') => {
      if (!focusedSupportsEffort) return
      setEffort(prev =>
        cycleEffortLevel(
          prev ?? focusedDefaultEffort,
          direction,
          focusedEffortLevels,
        ),
      )
      setHasToggledEffort(true)
    },
    [focusedSupportsEffort, focusedEffortLevels, focusedDefaultEffort],
  )

  // Effort cycling keybindings — only active when Select has focus (not tab header)
  useKeybindings(
    {
      'modelPicker:decreaseEffort': () => handleCycleEffort('left'),
      'modelPicker:increaseEffort': () => handleCycleEffort('right'),
    },
    { context: 'ModelPicker' },
  )

  function handleSelect(value: string): void {
    if (!skipSettingsWrite) {
      const effortLevel = resolvePickerEffortPersistence(
        effort,
        getDefaultEffortLevelForOption(value),
        getSettingsForSource('userSettings')?.effortLevel,
        hasToggledEffort,
      )
      const persistable = toPersistableEffort(effortLevel)
      if (persistable !== undefined) {
        updateSettingsForSource('userSettings', { effortLevel: persistable })
      }
      setAppState(prev => ({ ...prev, effortValue: effortLevel }))

      // Persist selectedEffort per-model in provider config when user explicitly toggled effort
      if (hasToggledEffort && value !== NO_PREFERENCE) {
        const resolvedModel = resolveOptionModel(value)
        if (resolvedModel && modelSupportsEffort(resolvedModel)) {
          const registry = getProviderRegistry()
          const providerNames = registry.getProviderNames()
          const defaultProvider = registry.getDefaultProviderName() ?? ''
          const parsed = parseModelString(value, providerNames, defaultProvider)
          const effortToWrite = toPersistableEffort(effort)
          updateProviderModelConfig(parsed.provider, parsed.modelId, {
            selectedEffort: effortToWrite,
          })
          resetProviderRegistry()
        }
      }
    }

    const selectedModel = resolveOptionModel(value)
    const selectedEffort =
      hasToggledEffort && selectedModel && modelSupportsEffort(selectedModel)
        ? effort
        : undefined
    if (value === NO_PREFERENCE) {
      onSelect(null, selectedEffort)
      return
    }
    onSelect(value, selectedEffort)
  }

  const handleTabChange = useCallback(
    (tabId: string) => {
      const idx = groups.findIndex(g => g.provider === tabId)
      if (idx !== -1) {
        setActiveTabIndex(idx)
        // Focus the first option in the new tab
        const firstOpt = groupSelectOptions[idx]?.[0]
        if (firstOpt) {
          setFocusedValue(firstOpt.value)
          if (!hasToggledEffort && effortValue === undefined) {
            setEffort(getDefaultEffortLevelForOption(firstOpt.value))
          }
        }
      }
    },
    [groups, groupSelectOptions, hasToggledEffort, effortValue],
  )

  const effortIndicator = (
    <Box marginBottom={1} flexDirection="column">
      {focusedSupportsEffort ? (
        <Text dimColor>
          <EffortLevelIndicator effort={displayEffort} />{' '}
          {capitalize(displayEffort)} effort
          {displayEffort === focusedDefaultEffort ? ` (default)` : ``}{' '}
          <Text color="subtle">← → to adjust</Text>
        </Text>
      ) : (
        <Text color="subtle">
          <EffortLevelIndicator effort={undefined} /> Effort not supported
          {focusedModelName ? ` for ${focusedModelName}` : ''}
        </Text>
      )}
    </Box>
  )

  const fastModeNotice = isFastModeEnabled() ? (
    showFastModeNotice ? (
      <Box marginBottom={1}>
        <Text dimColor>
          Fast mode is <Text bold>ON</Text> and available with{' '}
          {FAST_MODE_MODEL_DISPLAY} only (/fast). Switching to other models turn
          off fast mode.
        </Text>
      </Box>
    ) : isFastModeAvailable() && !isFastModeCooldown() ? (
      <Box marginBottom={1}>
        <Text dimColor>
          Use <Text bold>/fast</Text> to turn on Fast mode (
          {FAST_MODE_MODEL_DISPLAY} only).
        </Text>
      </Box>
    ) : null
  ) : null

  const footer = isStandaloneCommand ? (
    <Text dimColor italic>
      {exitState.pending ? (
        <>Press {exitState.keyName} again to exit</>
      ) : (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="confirm" />
          <ConfigurableShortcutHint
            action="select:cancel"
            context="Select"
            fallback="Esc"
            description="exit"
          />
        </Byline>
      )}
    </Text>
  ) : null

  const content = (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            Select model
          </Text>
          <Text dimColor>
            {headerText ??
              'Switch between models. Applies to this session and future sessions. For other/previous model names, specify with --model.'}
          </Text>
          {sessionModel && (
            <Text dimColor>
              Currently using {modelDisplayString(sessionModel)} for this
              session (set by plan mode). Selecting a model will undo this.
            </Text>
          )}
        </Box>

        {hasMultipleGroups ? (
          <TabbedModelList
            groups={groups}
            groupSelectOptions={groupSelectOptions}
            activeTabIndex={activeTabIndex}
            initialValue={initialValue}
            maxVisible={maxVisible}
            onSelect={handleSelect}
            onFocus={handleFocus}
            onCancel={onCancel ?? (() => {})}
            onTabChange={handleTabChange}
          />
        ) : (
          <SingleModelList
            options={groupSelectOptions[0] ?? []}
            initialValue={initialValue}
            maxVisible={maxVisible}
            onSelect={handleSelect}
            onFocus={handleFocus}
            onCancel={onCancel ?? (() => {})}
          />
        )}

        {effortIndicator}
        {fastModeNotice}
      </Box>

      {footer}
    </Box>
  )

  if (!isStandaloneCommand) {
    return content
  }

  return <Pane color="permission">{content}</Pane>
}

// --- Sub-components for single-list and tabbed modes -----------------------

function SingleModelList({
  options,
  initialValue,
  maxVisible,
  onSelect,
  onFocus,
  onCancel,
}: {
  options: SelectOption[]
  initialValue: string
  maxVisible: number
  onSelect: (value: string) => void
  onFocus: (value: string) => void
  onCancel: () => void
}): React.ReactNode {
  const initialFocusValue = options.some(o => o.value === initialValue)
    ? initialValue
    : (options[0]?.value ?? undefined)
  const visibleCount = Math.min(maxVisible, options.length)
  const hiddenCount = Math.max(0, options.length - visibleCount)

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column">
        <Select
          defaultValue={initialValue}
          defaultFocusValue={initialFocusValue}
          options={options}
          onChange={onSelect}
          onFocus={onFocus}
          onCancel={onCancel}
          visibleOptionCount={visibleCount}
        />
      </Box>
      {hiddenCount > 0 && (
        <Box paddingLeft={3}>
          <Text dimColor>and {hiddenCount} more…</Text>
        </Box>
      )}
    </Box>
  )
}

function TabbedModelList({
  groups,
  groupSelectOptions,
  activeTabIndex,
  initialValue,
  maxVisible,
  onSelect,
  onFocus,
  onCancel,
  onTabChange,
}: {
  groups: ModelOptionGroup[]
  groupSelectOptions: SelectOption[][]
  activeTabIndex: number
  initialValue: string
  maxVisible: number
  onSelect: (value: string) => void
  onFocus: (value: string) => void
  onCancel: () => void
  onTabChange: (tabId: string) => void
}): React.ReactNode {
  const activeProvider = groups[activeTabIndex]?.provider ?? groups[0]!.provider

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Tabs
        selectedTab={activeProvider}
        onTabChange={onTabChange}
        color="permission"
      >
        {groups.map((group, i) => (
          <Tab key={group.provider} title={group.provider} id={group.provider}>
            <ProviderTabContent
              options={groupSelectOptions[i] ?? []}
              initialValue={initialValue}
              maxVisible={maxVisible}
              onSelect={onSelect}
              onFocus={onFocus}
              onCancel={onCancel}
            />
          </Tab>
        ))}
      </Tabs>
    </Box>
  )
}

function ProviderTabContent({
  options,
  initialValue,
  maxVisible,
  onSelect,
  onFocus,
  onCancel,
}: {
  options: SelectOption[]
  initialValue: string
  maxVisible: number
  onSelect: (value: string) => void
  onFocus: (value: string) => void
  onCancel: () => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()

  const initialFocusValue = options.some(o => o.value === initialValue)
    ? initialValue
    : (options[0]?.value ?? undefined)
  const visibleCount = Math.min(maxVisible, options.length)
  const hiddenCount = Math.max(0, options.length - visibleCount)

  return (
    <Box flexDirection="column">
      <Select
        defaultValue={initialValue}
        defaultFocusValue={initialFocusValue}
        options={options}
        onChange={onSelect}
        onFocus={onFocus}
        onCancel={onCancel}
        visibleOptionCount={visibleCount}
        isDisabled={headerFocused}
        onUpFromFirstItem={focusHeader}
      />
      {hiddenCount > 0 && (
        <Box paddingLeft={3}>
          <Text dimColor>and {hiddenCount} more…</Text>
        </Box>
      )}
    </Box>
  )
}

// --- Helpers ---------------------------------------------------------------

function resolveOptionModel(value?: string): string | undefined {
  if (!value) return undefined
  return value === NO_PREFERENCE
    ? getDefaultMainLoopModel()
    : parseUserSpecifiedModel(value)
}

function EffortLevelIndicator({
  effort,
}: {
  effort?: EffortLevel
}): React.ReactNode {
  return (
    <Text color={effort ? 'claude' : 'subtle'}>
      {effortLevelToSymbol(effort ?? 'low')}
    </Text>
  )
}

function cycleEffortLevel(
  current: EffortLevel,
  direction: 'left' | 'right',
  levels: string[],
): EffortLevel {
  const idx = levels.indexOf(current)
  // If the current level isn't in the model's configured levels, start from
  // the closest match (last level for too-high, first for too-low).
  const currentIndex = idx !== -1 ? idx : Math.max(0, levels.length - 2)
  if (direction === 'right') {
    return levels[(currentIndex + 1) % levels.length]! as EffortLevel
  } else {
    return levels[(currentIndex - 1 + levels.length) % levels.length]! as EffortLevel
  }
}

function getDefaultEffortLevelForOption(value?: string): EffortLevel {
  const resolved = resolveOptionModel(value) ?? getDefaultMainLoopModel()
  // Check selectedEffort from provider config first (user's persisted preference)
  const selectedEffort = getProviderRegistry().getModelSelectedEffort(resolved)
  if (selectedEffort !== undefined) {
    return convertEffortValueToLevel(selectedEffort as EffortLevel)
  }
  const defaultValue = getDefaultEffortForModel(resolved)
  return defaultValue !== undefined
    ? convertEffortValueToLevel(defaultValue)
    : 'high'
}
