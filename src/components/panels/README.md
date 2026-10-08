# panels/ — host-agnostic TUI panels

Components in this module render the classic TUI's panels from **neutral
props** (data in, callbacks out) so any host can mount them. The classic
REPL is one host; it wires state through the adapters described below.

## Panel contract

- **Neutral props only.** No reads of the AppState store (`useAppState`,
  `useAppStateStore`, `useSetAppState`, `getAppState`) and no imports from
  `src/screens/`, `src/hooks/repl/`, `src/components/repl/`. Everything the
  panel knows arrives as props; everything it wants to change leaves as a
  typed callback.
- **Optional-context degradation, never requirements.** Panels may use
  hooks that no-op outside their providers — `useKeybinding(s)` without a
  keybinding provider, `useRegisterOverlay` / `useSetPromptOverlay`
  without the overlay provider, `useAppStateMaybeOutsideOfProvider`. A panel
  must render (degraded, not throw) with no provider mounted.
- **Terminal-generic hooks are fine** (`useTerminalSize`, Theme, settings
  via context). Hosts are other surfaces in this binary, not other
  processes.
- **Panels import panels, never adapters.** If a panel mounts another
  previously-extracted dialog, it imports the panel version and threads the
  props from its own (see `SettingsDialog/Config.tsx` mounting the
  MCP/Theme/Model picker panels). Host adapters are the only place store
  reads are allowed.
- **State that must re-render the host lives in an external store the host
  subscribes to.** See `commandPalette/paletteStore.ts` — a `createStore`
  store keeps palette updates and the host's suggestion-dependent input
  rendering in the same commit.

## Host adapters

The classic REPL's adapters keep the old import paths and export
signatures, so existing mounts are unchanged. Examples:

| Panel                                                                       | Host adapter (store boundary)                                     |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `commandPalette/`                                                           | `PromptInput` (+ `useAppStateTypeaheadDataSources`)               |
| `StatusLinePanel`                                                           | `components/StatusLine.tsx` (script pipeline)                     |
| `TaskPanel/`                                                                | `components/TaskLivePanel.tsx` (AppState/TasksV2 reads)           |
| `CoordinatorTaskPanel/`                                                     | `components/CoordinatorAgentStatus.tsx` (evict tick, kill wiring) |
| `BackgroundTasksDialog/`                                                    | `components/tasks/BackgroundTasksDialog.tsx` (Task.kill dispatch) |
| `dialog/DialogSlot`                                                         | mounted by `FullscreenLayout`'s `modal` slot                      |
| `ContextPanel/`                                                             | `commands/context/context.tsx` (renders via `renderToAnsiString`) |
| `ModelPickerDialog/`, `ThemePickerDialog/`, `FastModeDialog/`, `IdeDialog/` | the same-named files under `src/components/` or `src/commands/`   |
| `AgentsMenuDialog/`                                                         | `components/agents/AgentsMenu.tsx`                                |
| `HooksConfigDialog/`                                                        | `components/hooks/HooksConfigMenu.tsx`                            |
| `MemoryDialog/`                                                             | `components/memory/MemoryFileSelector.tsx`                        |
| `PermissionRulesDialog/`                                                    | `components/permissions/rules/PermissionRuleList.tsx`             |
| `MCPDialog/`                                                                | the same-named files under `src/components/mcp/`                  |
| `PluginDialog/`                                                             | `commands/plugin/PluginSettings.tsx` / `ManagePlugins.tsx`        |
| `SettingsDialog/`                                                           | `components/Settings/Config.tsx` / `Status.tsx`                   |

The remaining local-jsx dialogs were audited store-free and stay in place
(`Settings/Settings`, `DiffDialog`, `ExitFlow`, `ExportDialog`, `HelpV2`,
`IdeAutoConnectDialog`/`IdeOnboardingDialog`, `LoginChooser`,
`LogSelector`, `SkillsMenu`, `permissions/rules/AddWorkspaceDirectory`,
the plugin browse/discover/marketplace files, and the inline-Dialog command
files). A recursive audit (2026-10-08) confirmed no file under `panels/`
reaches a store-coupled module through its imports.

## Adding a host

Mount the provider tree you need (keybindings, overlay, prompt-overlay),
read your own state, and render the panels with props. Where a panel needs
data the classic host keeps in AppState, define the slice as a prop — see
`commandPalette/dataSources.ts` for the injectable-data-source pattern used
by the palette.
