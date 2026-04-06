import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getCompanion, companionUserId, roll } from '../../buddy/companion.js'
import { renderSprite } from '../../buddy/sprites.js'
import { RARITY_COLORS, RARITY_STARS, type Companion, STAT_NAMES } from '../../buddy/types.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

function renderBar(value: number, max = 100, width = 10): string {
  const filled = Math.round((value / max) * width)
  const empty = width - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

interface CompanionCardProps {
  companion: Companion
}

function CompanionCard({ companion }: CompanionCardProps) {
  const rarityColor = RARITY_COLORS[companion.rarity]
  const stars = RARITY_STARS[companion.rarity]
  const sprite = renderSprite(companion, 0)

  return (
    <Box flexDirection="column" alignItems="center">
      {/* Card border top */}
      <Text>╭──────────────────────────────────────╮</Text>
      <Text>│                                      │</Text>

      {/* Header: Rarity and Species */}
      <Box width={38} justifyContent="space-between" paddingX={1}>
        <Text>
          {stars} <Text bold color={rarityColor}>{companion.rarity.toUpperCase()}</Text>
        </Text>
        <Text bold>{companion.species.toUpperCase()}</Text>
      </Box>

      <Text>│                                      │</Text>

      {/* Sprite */}
      <Box flexDirection="column" alignItems="center" width={38}>
        {sprite.map((line, i) => (
          <Text key={i}>{line.replace(/{E}/g, companion.eye)}</Text>
        ))}
      </Box>

      <Text>│                                      │</Text>

      {/* Name */}
      <Box width={38} justifyContent="center">
        <Text bold>{companion.name}</Text>
        {companion.shiny && <Text color="warning"> ✨</Text>}
      </Box>

      <Text>│                                      │</Text>

      {/* Personality quote */}
      <Box width={38} justifyContent="center" paddingX={1}>
        <Text dimColor>"{companion.personality}"</Text>
      </Box>

      <Text>│                                      │</Text>

      {/* Stats */}
      {STAT_NAMES.map((statName) => {
        const value = companion.stats[statName]
        const bar = renderBar(value)
        return (
          <Box key={statName} width={38} paddingX={1}>
            <Text color="inactive">{statName.padEnd(11)} {bar} {value.toString().padStart(3)}</Text>
          </Box>
        )
      })}

      <Text>│                                      │</Text>
      <Text>╰──────────────────────────────────────╯</Text>
    </Box>
  )
}

interface BuddyViewProps {
  companion: Companion
  onDone: LocalJSXCommandOnDone
}

function BuddyView({ companion, onDone }: BuddyViewProps) {
  // Listen for any input and exit immediately
  useInput(() => {
    onDone()
  })

  return (
    <Box padding={1}>
      <CompanionCard companion={companion} />
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const arg = args.trim().toLowerCase()

  if (arg && arg !== 'off') {
    onDone('Usage: /buddy [off]', { display: 'system' })
    return null
  }

  // Try to get existing companion
  let companion = getCompanion()
  const { companionMuted } = getGlobalConfig()

  if (arg === 'off') {
    if (!companion) {
      onDone('No buddy to hide yet. Run `/buddy` first.', { display: 'system' })
      return null
    }

    if (companionMuted) {
      onDone('Buddy is already hidden.', { display: 'system' })
      return null
    }

    saveGlobalConfig(current => ({
      ...current,
      companionMuted: true,
    }))
    onDone('Buddy hidden. Run `/buddy` again to show it.', {
      display: 'system',
    })
    return null
  }

  if (companionMuted) {
    saveGlobalConfig(current => ({
      ...current,
      companionMuted: false,
    }))
  }

  // If no companion exists, create one
  if (!companion) {
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

    const newCompanion: Companion = {
      ...bones,
      name,
      personality,
      hatchedAt: Date.now(),
    }

    // Save to config
    saveGlobalConfig(current => ({
      ...current,
      companion: {
        name: newCompanion.name,
        personality: newCompanion.personality,
        hatchedAt: newCompanion.hatchedAt,
      },
      companionMuted: false,
    }))

    companion = newCompanion
  }

  return <BuddyView companion={companion} onDone={onDone} />
}
