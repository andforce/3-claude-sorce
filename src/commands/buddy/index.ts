import type { Command } from '../../commands.js'

const buddy = {
  type: 'local-jsx',
  name: 'buddy',
  description: 'Hatch and interact with your companion',
  argumentHint: '[off]',
  immediate: true,
  load: () => import('./buddy.js'),
} satisfies Command

export default buddy
