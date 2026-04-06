import {
  getGlobalConfig,
  type ConnectedProviderInfo,
  type GlobalConfig,
} from './config.js'

function hasRequiredProviderFields(
  providerId: string,
  provider: ConnectedProviderInfo | undefined,
): boolean {
  switch (providerId) {
    case 'github-copilot':
      return !!provider?.oauthToken
    case 'openrouter':
    case 'kimi-for-coding':
      return !!provider?.apiKey
    case 'custom-openai':
    case 'custom-anthropic':
      return !!provider?.baseUrl
    default:
      return !!(
        provider?.apiKey ||
        provider?.oauthToken ||
        provider?.baseUrl ||
        provider?.enterpriseUrl
      )
  }
}

export function hasConnectedProviderCredentials(
  providerId: string | undefined,
  config: GlobalConfig = getGlobalConfig(),
): boolean {
  if (!providerId) {
    return false
  }

  return hasRequiredProviderFields(
    providerId,
    config.connectedProviders?.[providerId],
  )
}

export function hasConnectedActiveProvider(
  config: GlobalConfig = getGlobalConfig(),
): boolean {
  return hasConnectedProviderCredentials(config.activeProvider, config)
}
