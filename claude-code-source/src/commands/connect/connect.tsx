import { feature } from 'bun:bundle'
import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { Select, OptionWithDescription } from '../../components/CustomSelect/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import { fetchCopilotModelsFromModelsDev } from '../../services/api/copilotClient.js'

const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
const COPILOT_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const COPILOT_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

const PROVIDERS: OptionWithDescription<string>[] = [
  {
    value: 'github-copilot',
    label: 'GitHub Copilot',
    hint: 'Use GitHub Copilot models (GPT-4o, Claude, etc.) via OAuth',
  },
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
  | { type: 'copilot-oauth'; userCode: string; verificationUri: string; deviceCode: string; interval: number }
  | { type: 'copilot-polling'; userCode: string; verificationUri: string; deviceCode: string; interval: number }

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

function CopilotOAuthDialog({
  userCode,
  verificationUri,
  onPollingStart,
  onCancel,
}: {
  userCode: string
  verificationUri: string
  onPollingStart: () => void
  onCancel: () => void
}) {
  React.useEffect(() => {
    const timer = setTimeout(() => {
      onPollingStart()
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">GitHub Copilot Authorization</Text>
      <Text>
        1. Open: <Text color="cyan" underline>{verificationUri}</Text>
      </Text>
      <Text>
        2. Enter code: <Text bold color="yellow">{userCode}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Waiting for authorization... (Press Esc to cancel)</Text>
      </Box>
    </Box>
  )
}

function CopilotPollingDialog({
  userCode,
  verificationUri,
  deviceCode,
  interval,
  onSuccess,
  onError,
  onCancel,
}: {
  userCode: string
  verificationUri: string
  deviceCode: string
  interval: number
  onSuccess: (token: string) => void
  onError: (error: string) => void
  onCancel: () => void
}) {
  const [status, setStatus] = React.useState('Waiting for authorization...')
  const cancelledRef = React.useRef(false)

  React.useEffect(() => {
    let stopped = false

    async function poll() {
      let currentInterval = interval
      while (!stopped && !cancelledRef.current) {
        await new Promise(resolve => setTimeout(resolve, currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS))
        if (stopped || cancelledRef.current) return

        try {
          const response = await fetch(COPILOT_ACCESS_TOKEN_URL, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              client_id: COPILOT_CLIENT_ID,
              device_code: deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
          })

          if (!response.ok) {
            onError('Failed to get access token')
            return
          }

          const data = await response.json() as {
            access_token?: string
            error?: string
            interval?: number
          }

          if (data.access_token) {
            onSuccess(data.access_token)
            return
          }

          if (data.error === 'authorization_pending') {
            setStatus('Waiting for authorization...')
            continue
          }

          if (data.error === 'slow_down') {
            currentInterval = (data.interval ?? currentInterval + 5)
            setStatus('Rate limited, slowing down...')
            continue
          }

          if (data.error === 'expired_token') {
            onError('Authorization expired, please try again')
            return
          }

          if (data.error === 'access_denied') {
            onError('Authorization was denied')
            return
          }

          if (data.error) {
            onError(`OAuth error: ${data.error}`)
            return
          }
        } catch (err) {
          onError(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
          return
        }
      }
    }

    void poll()

    return () => {
      stopped = true
    }
  }, [deviceCode, interval])

  useInput((_, key) => {
    if (key.escape) {
      cancelledRef.current = true
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">GitHub Copilot Authorization</Text>
      <Text>
        1. Open: <Text color="cyan" underline>{verificationUri}</Text>
      </Text>
      <Text>
        2. Enter code: <Text bold color="yellow">{userCode}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{status}</Text>
      </Box>
      <Text dimColor>Press Esc to cancel</Text>
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

  const providerName = providerId === 'github-copilot' ? 'GitHub Copilot' : PROVIDER_CONFIG[providerId]?.name ?? providerId

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">
        Successfully connected to <Text bold>{providerName}</Text>
      </Text>
      <Text dimColor>
        You can now use models from {providerName} with the /model command.
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

  const handleProviderSelect = async (providerId: string) => {
    if (providerId === 'github-copilot') {
      try {
        const response = await fetch(COPILOT_DEVICE_CODE_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: COPILOT_CLIENT_ID,
            scope: 'read:user',
          }),
        })

        if (!response.ok) {
          setStep({ type: 'error', error: 'Failed to initiate GitHub device authorization' })
          return
        }

        const data = await response.json() as {
          verification_uri: string
          user_code: string
          device_code: string
          interval: number
        }

        setStep({
          type: 'copilot-oauth',
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          deviceCode: data.device_code,
          interval: data.interval,
        })
      } catch (err) {
        setStep({
          type: 'error',
          error: `Failed to connect: ${err instanceof Error ? err.message : 'unknown error'}`,
        })
      }
      return
    }

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
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          [providerId]: {
            apiKey,
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || providerId,
      }))

      setStep({ type: 'success', providerId })
    } catch (error) {
      setStep({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  const handleCopilotSuccess = (token: string) => {
    try {
      saveGlobalConfig(current => ({
        ...current,
        connectedProviders: {
          ...(current.connectedProviders || {}),
          'github-copilot': {
            oauthToken: token,
            connectedAt: new Date().toISOString(),
          },
        },
        activeProvider: current.activeProvider || 'github-copilot',
      }))

      // Pre-fetch and cache the model list in background
      fetchCopilotModelsFromModelsDev().then(models => {
        saveGlobalConfig(current => ({
          ...current,
          copilotModelsCache: { models, fetchedAt: Date.now() },
        }))
      }).catch(() => {})

      setStep({ type: 'success', providerId: 'github-copilot' })
    } catch (error) {
      setStep({
        type: 'error',
        error: error instanceof Error ? error.message : 'Failed to save OAuth token',
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

  if (step.type === 'copilot-oauth') {
    return (
      <Dialog title="GitHub Copilot" onCancel={handleCancel}>
        <CopilotOAuthDialog
          userCode={step.userCode}
          verificationUri={step.verificationUri}
          onPollingStart={() => {
            setStep({
              type: 'copilot-polling',
              userCode: step.userCode,
              verificationUri: step.verificationUri,
              deviceCode: step.deviceCode,
              interval: step.interval,
            })
          }}
          onCancel={handleCancel}
        />
      </Dialog>
    )
  }

  if (step.type === 'copilot-polling') {
    return (
      <Dialog title="GitHub Copilot" onCancel={handleCancel}>
        <CopilotPollingDialog
          userCode={step.userCode}
          verificationUri={step.verificationUri}
          deviceCode={step.deviceCode}
          interval={step.interval}
          onSuccess={handleCopilotSuccess}
          onError={(error) => setStep({ type: 'error', error })}
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
