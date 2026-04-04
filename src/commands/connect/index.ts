import type { Command } from '../../commands.js'

const connect = {
  type: 'local-jsx',
  name: 'connect',
  description: 'Connect a provider',
  load: () => import('./connect.js'),
} satisfies Command

export default connect
