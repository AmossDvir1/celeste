import { PATTERNS, moonName, type MoonPattern, type MoonRole, type Seat } from '@shared/moons'
import { useThemeName } from '@/features/visuals/chat'
import { avatarFor } from './avatars'
import { useCharacters } from './instance'
import { roleColor, type MoonColor, type MoonTheme } from './palette'

/** How a seat looks in the thread, the header and the picker: its name, its role and its color in the theme in use. */
export interface SeatLook {
  seat: Seat
  name: string
  role: MoonRole
  /** The second of two moons with the same role, which takes the other color. */
  second: boolean
  color: MoonColor
}

export function seatLook(pattern: MoonPattern, seat: Seat, theme: MoonTheme): SeatLook {
  const roles = PATTERNS[pattern].roles
  const second = seat === 1 && roles[0] === roles[1]
  return { seat, name: moonName(pattern, seat), role: roles[seat], second, color: roleColor(roles[seat], second, theme) }
}

export function useMoonTheme(): MoonTheme {
  return useThemeName() === 'light' ? 'light' : 'dark'
}

/** The small picture of a moon's face, or an empty string while it is not ready (or when WebGL is not there): the caller draws a plain dot then. */
export function useMoonAvatar(role: MoonRole, second: boolean): string {
  const chars = useCharacters()
  const theme = useMoonTheme()
  return avatarFor(chars, role, second, theme)
}
