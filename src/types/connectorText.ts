export type ConnectorTextBlock = { type: 'connector_text'; text: string }
export function isConnectorTextBlock(block: unknown): block is ConnectorTextBlock {
  return typeof block === 'object' && block !== null && (block as any).type === 'connector_text'
}
