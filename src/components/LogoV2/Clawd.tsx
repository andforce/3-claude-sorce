import * as React from 'react'
import { Box, Text } from '../../ink.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'

type Props = {
  pose?: ClawdPose
}

type LogoFrame = readonly [string, string, string]

const POSES: Record<ClawdPose, LogoFrame> = {
  default: [' ▗▌▄▄▄▐▖ ', '▐ ◉ ▄ ◉ ▌', ' ▝▀▀▀▀▀▘ '],
  'arms-up': ['▗▟▌▄▄▄▐▙▖', '▐ ◉ ▀ ◉ ▌', '  ▝▀▀▀▘  '],
  'look-left': [' ▗▌▄▄▄▐▖ ', '▐ ◐ ▄ ◑ ▌', ' ▝▀▀▀▀▀▘ '],
  'look-right': [' ▗▌▄▄▄▐▖ ', '▐ ◑ ▄ ◐ ▌', ' ▝▀▀▀▀▀▘ '],
}

export function Clawd({ pose = 'default' }: Props = {}): React.ReactNode {
  const frame = POSES[pose]

  return (
    <Box flexDirection="column">
      {frame.map((row, index) => (
        <Text key={index} color="clawd_body">
          {row}
        </Text>
      ))}
    </Box>
  )
}
