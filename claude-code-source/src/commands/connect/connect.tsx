import { feature } from 'bun:bundle'
import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { Select, OptionWithDescription } from '../../components/CustomSelect/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'

// Provider definitions
const PROVIDERS: OptionWithDescription<string>[] = [
  {
    value: 'kimi-for-coding',
    label: 'Kimi For Coding',
    hint: 'Moonshot AI\'s coding-optimized model',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    hint: 'GPT-4, GPT-3.5 Turbo, and more',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'Unified API for multiple models',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Claude 3.5 Sonnet, Opus, and Haiku',
  },
]

const PROVIDER_CONFIG: Record<string, { name: string; apiKeyUrl: string; keyPlaceholder: string }> = {
  'kimi-for-coding': {
    name: 'Kimi For Coding',
    apiKeyUrl: 'https://platform.moonshot.cn/',
    keyPlaceholder: 'sk-...',
  },
  openai: {
    name: 'OpenAI',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
  },
  openrouter: {
    name: 'OpenRouter',
    apiKeyUrl: 'https://openrouter.ai/keys',
    keyPlaceholder: 'sk-or-...',
  },
  anthropic: {
    name: 'Anthropic',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-...',
  },
}

type ConnectStep =
  | { type: 'select-provider' }
  | { type: 'enter-api-key'; providerId: string }
  | { type: 'confirm'; providerId: string; apiKey: string }
  | { type: 'success'; providerId: string }
  | { type: 'error'; error: string }

function ApiKeyInput({
  providerId,
  onSubmit,
  onCancel,
}: {
  providerId: string
  onSubmit: (apiKey: string) => void
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const provider = PROVIDER_CONFIG[providerId]

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      if (apiKey.trim()) {
        onSubmit(apiKey.trim())
      }
      return
    }
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = apiKey.slice(0, cursorOffset - 1) + apiKey.slice(cursorOffset)
        setApiKey(newValue)
        setCursorOffset(cursorOffset - 1)
      }
      return
    }
    if (input) {
      const newValue = apiKey.slice(0, cursorOffset) + input + apiKey.slice(cursorOffset)
      setApiKey(newValue)
      setCursorOffset(cursorOffset + input.length)
    }
  })

  const displayValue = apiKey ? '*'.repeat(apiKey.length) : ''
  const cursorChar = cursorOffset < displayValue.length ? displayValue[cursorOffset] : ' '
  const beforeCursor = displayValue.slice(0, cursorOffset)
  const afterCursor = displayValue.slice(cursorOffset + 1)

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{provider.name}</Text>
      <Text dimColor>
        Get your API key from:{' '}
        <Text color="cyan" underline>
          {provider.apiKeyUrl}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>API Key:</Text>
        <Box>
          <Text>{beforeCursor}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{afterCursor}</Text>
        </Box>
      </Box>
      <Text dimColor>Press Enter to continue, Esc to cancel</Text>
    </Box>
  )
}

function ConfirmDialog({
  providerId,
  apiKey,
  onConfirm,
  onCancel,
}: {
  providerId: string
  apiKey: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      onConfirm()
      return
    }
  })

  const provider = PROVIDER_CONFIG[providerId]
  const maskedKey = `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        Connect to <Text bold>{provider.name}</Text>?
      </Text>
      <Text dimColor>
        API Key: <Text color="yellow">{maskedKey}</Text>
      </Text>
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text color="green" bold>
          [Enter] Connect
        </Text>
        <Text dimColor>[Esc] Cancel</Text>
      </Box>
    </Box>
  )
}

function SuccessDialog({
  providerId,
  onClose,
}: {
  providerId: string
  onClose: () => void
}) {
  useInput(() => {
    onClose()
  })

  const provider = PROVIDER_CONFIG[providerId]

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">
        Successfully connected to <Text bold>{provider.name}</Text>
      </Text>
      <Text dimColor>
        You can now use models from {provider.name} with the /model command.
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Press any key to continue</Text>
      </Box>
    </Box>
  )
}

function ErrorDialog({ error, onClose }: { error: string; onClose: () => void }) {
  useInput(() => {
    onClose()
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="red">Failed to connect provider:</Text>
      <Text>{error}</Text>
      <Box marginTop={1}>
        <Text dimColor>Press any key to go back</Text>
      </Box>
    </Box>
  )
}

function ConnectDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}) {
  const [step, setStep] = React.useState<ConnectStep>({ type: 'select-provider' })
  const setAppState = useSetAppState()

  const handleProviderSelect = (providerId: string) => {
    if (!PROVIDER_CONFIG[providerId]) {
      setStep({ type: 'error', error: `Unknown provider: ${providerId}` })
      return
    }
    setStep({ type: 'enter-api-key', providerId })
  }

  const handleApiKeySubmit = (apiKey: string) => {
    if (step.type !== 'enter-api-key') return
    setStep({ type: 'confirm', providerId: step.providerId, apiKey })
  }

  const handleConfirm = async () => {
    if (step.type !== 'confirm') return

    const { providerId, apiKey } = step

    try {
      // Save the provider credentials to global config
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          [providerId]: {
            apiKey,
            connectedAt: new Date().toISOString(),
          },
        },
        // Set as active provider if none is set
        activeProvider: current.activeProvider || providerId,
      }))

      // Update app state to reflect the new provider
      setAppState(s => ({
        ...s,
        connectedProviders: {
          ...(s.connectedProviders || {}),
          [providerId]: {
            apiKey,
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: s.activeProvider || providerId,
      }))

      setStep({ type: 'success', providerId })
    } catch (error) {
      setStep({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  const handleCancel = () => {
    onDone({ exitState: 'cancelled' })
  }

  const handleSuccessClose = () => {
    onDone({ exitState: 'success' })
  }

  const handleErrorClose = () => {
    setStep({ type: 'select-provider' })
  }

  // Render based on current step
  if (step.type === 'select-provider') {
    return (
      <Dialog title="Connect a Provider" onCancel={handleCancel}>
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Select a provider to connect:</Text>
          <Select
            options={PROVIDERS}
            onChange={value => handleProviderSelect(value)}
            onCancel={handleCancel}
          />
        </Box>
      </Dialog>
    )
  }

  if (step.type === 'enter-api-key') {
    return (
      <Dialog title={`Connect ${PROVIDER_CONFIG[step.providerId].name}`} onCancel={handleCancel}>
        <ApiKeyInput
          providerId={step.providerId}
          onSubmit={handleApiKeySubmit}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'confirm') {
    return (
      <Dialog title="Confirm Connection" onCancel={handleCancel}>
        <ConfirmDialog
          providerId={step.providerId}
          apiKey={step.apiKey}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'success') {
    return (
      <Dialog title="Success!" onCancel={handleSuccessClose}>
        <SuccessDialog providerId={step.providerId} onClose={handleSuccessClose} />
      </Dialog>
    )
  }

  if (step.type === 'error') {
    return (
      <Dialog title="Error" onCancel={handleErrorClose}>
        <ErrorDialog error={step.error} onClose={handleErrorClose} />
      </Dialog>
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <ConnectDialog onDone={onDone} />
}

export default call
