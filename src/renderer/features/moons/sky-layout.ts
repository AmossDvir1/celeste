/*
 * Where everything of the sky is, worked out from its width and the window's height: the canvas (sky-draw.ts) and the cards (MoonsSky.tsx) take it from
 * here, so they always agree. The sky may be wider than the message box under it: the moons then have the room beside it, and the card's edge and the
 * words stay in line with the box.
 */

/** The width of the message box (ConversationView.tsx). */
const COLUMN = 820

export interface SkyLayout {
  /** Narrow: the moons are above the card, not beside it. */
  phone: boolean
  H: number
  /** From the edges to the caption, the track and the card's outer edge. */
  pad: number
  /** `left`: the left edge of the one card. `side`: the outer edges of two. */
  card: { top: number; height: number; left: number; side: number }
  /** The moons: the middle of their orbit, how wide it is, and how big they are. */
  cx: number
  cy: number
  rx: number
  r: number
  /** When they talk: how far each is from its edge, their height, and the box of the conversation between them. */
  talk: { x: number; y: number; left: number; right: number; top: number; bottom: number }
}

export function skyLayout(W: number, windowHeight: number): SkyLayout {
  if (W < 640) {
    return {
      phone: true,
      H: 336,
      pad: 14,
      card: { top: 152, height: 138, left: 14, side: 14 },
      cx: W / 2,
      cy: 84,
      rx: 86,
      r: 27,
      talk: { x: 56, y: 336 - 78, left: 12, right: 12, top: 8, bottom: 124 }
    }
  }
  // A low window keeps the smaller sky, so the thread above it keeps its room.
  const low = windowHeight < 740
  const wide = W >= 900
  const pad = Math.max(20, Math.round((W - COLUMN) / 2))
  const cx = wide ? Math.max(142, 88 + pad) : 140
  const x = wide ? Math.round(72 + pad / 2) : 92
  return {
    phone: false,
    H: low ? 250 : 300,
    pad,
    card: { top: 28, height: low ? 152 : 198, left: wide ? cx + 158 : 300, side: wide ? Math.max(20, pad - 40) : 20 },
    cx,
    cy: low ? 112 : 136,
    rx: wide ? 92 : 86,
    r: low ? 35 : wide ? 41 : 37,
    talk: { x, y: low ? 146 : 180, left: x + 78, right: x + 78, top: 8, bottom: 44 }
  }
}

/** How many words the thinking map can hold in a card this wide without cutting most of them. */
export const mapRoom = (cardWidth: number): number => (cardWidth >= 440 ? 6 : cardWidth >= 330 ? 5 : 4)
