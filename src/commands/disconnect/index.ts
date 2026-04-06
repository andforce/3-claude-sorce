import type { Command } from '../../commands.js'

const disconnect = {
  type: 'local-jsx',
  name: 'disconnect',
  description: 'Disconnect a provider',
  load: () => import('./disconnect.js'),
} satisfies Command

export default disconnect
