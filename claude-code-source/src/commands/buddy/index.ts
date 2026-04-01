import type { Command } from '../../commands.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { companionUserId, roll } from '../../buddy/companion.js'

const buddy = {
  type: 'prompt',
  name: 'buddy',
  description: 'Hatch and interact with your companion',
  contentLength: 0,
  progressMessage: 'summoning your companion',
  source: 'builtin',
  async getPromptForCommand() {
    const config = getGlobalConfig()

    if (config.companion) {
      return [{
        type: 'text',
        text: `Your companion ${config.companion.name} is already hatched! They sit beside your input box and watch you work.`,
      }]
    }

    // Hatch a new companion
    const userId = companionUserId()
    const { bones } = roll(userId)

    const defaultNames: Record<string, string> = {
      duck: 'Quackers',
      goose: 'Honk',
      blob: 'Blobby',
      cat: 'Whiskers',
      dragon: 'Ember',
      octopus: 'Inky',
      owl: 'Hoot',
      penguin: 'Waddle',
      turtle: 'Shelly',
      snail: 'Gary',
      ghost: 'Casper',
      axolotl: 'Bubbles',
      capybara: 'Mochi',
      cactus: 'Spike',
      robot: 'Beep',
      rabbit: 'Bunny',
      mushroom: 'Shroom',
      chonk: 'Chonky',
    }

    const name = defaultNames[bones.species] || 'Buddy'
    const personality = `A ${bones.rarity} ${bones.species} with ${bones.eye} eyes${bones.shiny ? ' (shiny!)' : ''}`

    saveGlobalConfig(current => ({
      ...current,
      companion: {
        name,
        personality,
        hatchedAt: Date.now(),
      }
    }))

    return [{
      type: 'text',
      text: `✨ Your companion has hatched! ✨

Name: ${name}
Species: ${bones.species}
Rarity: ${bones.rarity}${bones.shiny ? ' (shiny!)' : ''}

${personality}

Your companion now sits beside your input box and will occasionally comment on your work.`,
    }]
  },
} satisfies Command

export default buddy
