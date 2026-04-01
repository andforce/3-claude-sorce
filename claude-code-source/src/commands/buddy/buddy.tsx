import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getCompanion, companionUserId, roll } from '../../buddy/companion.js'
import { renderSprite, renderFace } from '../../buddy/sprites.js'
import { RARITY_COLORS, RARITY_STARS, type Companion } from '../../buddy/types.js'
import type { LocalJSXCommandContext } from '../../commands.js'

interface BuddyProps {
  context: LocalJSXCommandContext
}

function BuddyCommand({ context }: BuddyProps): React.ReactElement {
  const [companion, setCompanion] = useState<Companion | undefined>(getCompanion())
  const [justHatched, setJustHatched] = useState(false)

  useEffect(() => {
    if (!companion) {
      // Hatch a new companion
      const userId = companionUserId()
      const { bones } = roll(userId)

      // Generate a name based on species
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

      // Save to config (only soul is persisted)
      saveGlobalConfig(current => ({
        ...current,
        companion: {
          name: newCompanion.name,
          personality: newCompanion.personality,
          hatchedAt: newCompanion.hatchedAt,
        }
      }))

      setCompanion(newCompanion)
      setJustHatched(true)
    }
  }, [companion])

  if (!companion) {
    return (
      <Box padding={1}>
        <Text color="info">Hatching your companion...</Text>
      </Box>
    )
  }

  const sprite = renderSprite(companion, 0)
  const face = renderFace(companion)
  const rarityColor = RARITY_COLORS[companion.rarity]
  const stars = RARITY_STARS[companion.rarity]

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      {justHatched && (
        <Box marginBottom={1}>
          <Text color="success">✨ Your companion has hatched! ✨</Text>
        </Box>
      )}

      <Box flexDirection="row" gap={2}>
        {/* Sprite display */}
        <Box flexDirection="column">
          {sprite.map((line, i) => (
            <Text key={i}>{line.replace(/{E}/g, companion.eye)}</Text>
          ))}
        </Box>

        {/* Companion info */}
        <Box flexDirection="column" gap={1}>
          <Box>
            <Text bold color={rarityColor}>
              {companion.name} {stars}
            </Text>
            {companion.shiny && <Text color="warning"> ✨</Text>}
          </Box>

          <Text color="inactive">Species: {companion.species}</Text>
          <Text color="inactive">Rarity: {companion.rarity}</Text>

          {companion.hat !== 'none' && (
            <Text color="inactive">Hat: {companion.hat}</Text>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Stats:</Text>
            {Object.entries(companion.stats).map(([stat, value]) => (
              <Text key={stat} color="inactive">
                {stat}: {value}
              </Text>
            ))}
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Your companion sits beside your input box and watches you work.
        </Text>
      </Box>

      <Box>
        <Text dimColor>
          It will occasionally react to your conversations with speech bubbles.
        </Text>
      </Box>
    </Box>
  )
}

export default function buddy(props: LocalJSXCommandContext): React.ReactElement {
  return <BuddyCommand context={props} />
}
