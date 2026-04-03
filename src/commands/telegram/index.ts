import type { Command } from '../../commands.js'

const telegram = {
  type: 'local-jsx',
  name: 'telegram',
  description: 'Connect a Telegram bot to this session',
  load: () => import('./telegram.js'),
} satisfies Command

export default telegram
