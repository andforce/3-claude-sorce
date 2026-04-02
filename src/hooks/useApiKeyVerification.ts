import { useCallback, useState } from 'react'

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  // 这个重建仓库本地运行时没有稳定的 Claude 登录环境，统一 mock 为已登录。
  const [status, setStatus] = useState<VerificationStatus>('valid')
  const [error, setError] = useState<Error | null>(null)

  const verify = useCallback(async (): Promise<void> => {
    setError(null)
    setStatus('valid')
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}
