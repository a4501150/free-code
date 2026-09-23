/**
 * The login chooser: pick which OAuth login to run. Driven by the login
 * layer's LOGIN_METHODS metadata, so a new login appears here automatically.
 * Embeddable (no Dialog) so both /login and onboarding can host it.
 */
import React, { useState } from 'react'
import { LOGIN_METHODS } from '../services/oauth/logins/index.js'
import { Box, Text } from '../ink.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { CodexOAuthFlow } from './CodexOAuthFlow.js'
import { Select } from './CustomSelect/select.js'

type Props = {
  /** Called when a login completed successfully. */
  onDone(): void
  startingMessage?: string
}

export function LoginChooser({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const [flow, setFlow] = useState<'select' | 'claude' | 'codex'>('select')

  if (flow === 'claude') {
    return (
      <ConsoleOAuthFlow onDone={onDone} startingMessage={startingMessage} />
    )
  }
  if (flow === 'codex') {
    return <CodexOAuthFlow onDone={onDone} startingMessage={startingMessage} />
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      {startingMessage ? (
        <Text bold>{startingMessage}</Text>
      ) : (
        <Text bold>Sign in with one of your provider accounts:</Text>
      )}
      <Text>Select login method:</Text>
      <Box>
        <Select
          options={LOGIN_METHODS.map(method => ({
            label: (
              <Text>
                {method.label} · <Text dimColor>{method.description}</Text>
                {'\n'}
              </Text>
            ),
            value: method.kind,
          }))}
          onChange={value => setFlow(value === 'codex' ? 'codex' : 'claude')}
        />
      </Box>
    </Box>
  )
}
