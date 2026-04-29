import type { KEYBINDING_ACTIONS, KEYBINDING_CONTEXTS } from './schema.js'

export type KeybindingContextName = (typeof KEYBINDING_CONTEXTS)[number]
export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]

export type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export type Chord = ParsedKeystroke[]

export type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

export type ParsedBinding = {
  context: KeybindingContextName
  chord: Chord
  action: string | null
}
