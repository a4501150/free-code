import { getCommandName, type CommandBase } from '../types/command.js'
import { getModelOptions } from '../utils/model/modelOptions.js'
import { WirePermissionModeSchema, type WireCatalog } from '../session/wire.js'

/**
 * The catalog of choices the session currently offers.
 *
 * Both process kinds build it the same way so a client sees one shape of
 * "what can I switch to" regardless of who owns the session. A misconfigured
 * provider registry must not break the wire, so the model list degrades to
 * empty rather than throwing on the publish path.
 */
export function buildWireCatalog(
  commands: readonly CommandBase[],
): WireCatalog {
  let models: WireCatalog['models'] = []
  try {
    models = getModelOptions().map(option => ({
      // The null-valued entry IS the "Default" choice on the v2 wire —
      // `model_set` carries null to return to it.
      value: typeof option.value === 'string' ? option.value : null,
      label: option.label,
    }))
  } catch {
    models = []
  }
  return {
    models,
    commands: commands
      .filter(command => !command.isHidden)
      // The classic palette's categorized order for the bare `/`: built-in
      // commands first, then user/project prompt commands, then everything
      // else (bundled skills etc. sort last), each category alphabetical
      // (generateCommandSuggestions's query==='' branch). The browser sorts
      // its own palette, so the row order is free for the terminal viewer
      // to mirror. type/source live on the command variants, not the base.
      .map(command => ({
        command,
        rank:
          (command as { type?: string }).type === 'local' ||
          (command as { type?: string }).type === 'local-jsx'
            ? 0
            : (command as { type?: string }).type === 'prompt' &&
                ((command as { source?: string }).source === 'userSettings' ||
                  (command as { source?: string }).source === 'localSettings')
              ? 1
              : (command as { type?: string }).type === 'prompt' &&
                  (command as { source?: string }).source === 'projectSettings'
                ? 2
                : 3,
      }))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          getCommandName(a.command).localeCompare(getCommandName(b.command)),
      )
      .map(({ command }) => ({
        name: getCommandName(command),
        description: command.description,
        argHint: command.argumentHint,
        ...(command.aliases?.length ? { aliases: command.aliases } : {}),
        // applyCommandSuggestion's execute-on-Enter rule: everything but a
        // prompt command with named arguments runs in place; those stay in
        // the input waiting for their arguments.
        runsDirectly:
          (command as { type?: string }).type !== 'prompt' ||
          ((command as { argNames?: string[] }).argNames ?? []).length === 0,
      })),
    permissionModes: WirePermissionModeSchema.options,
  }
}
