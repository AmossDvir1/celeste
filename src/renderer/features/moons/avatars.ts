import type { MoonRole } from '@shared/moons'
import type { Characters } from './characters'
import type { MoonTheme } from './palette'
import { roleColor } from './palette'

/** A small picture of each character's face as a data URL, for the thread and the header. Cached, because making one means rendering it. */
const cache = new Map<string, string>()

const SIZE = 96

export function avatarFor(chars: Characters | null, role: MoonRole, second: boolean, theme: MoonTheme): string {
  const key = `${role}:${second ? 2 : 1}:${theme}`
  const known = cache.get(key)
  if (known !== undefined) return known
  if (!chars) return ''
  let url = ''
  try {
    url = chars.snapshot(role, roleColor(role, second, theme), theme, SIZE)
  } catch (error) {
    console.warn('The moon avatar could not be drawn.', error)
  }
  // A failed one is not kept, so it is tried again when the characters are back.
  if (url) cache.set(key, url)
  return url
}
