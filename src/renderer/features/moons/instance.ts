import { useEffect, useState } from 'react'
import { createCharacters, type Characters } from './characters'

/*
 * One set of characters for the whole window: they share one WebGL context, and a browser allows only so many. Made the first time a chat with
 * two moons is shown (Three.js is loaded then, not before), and kept. Null where there is no WebGL: the plain moons are drawn.
 *
 * The computer's graphics process can go away while Celeste runs (a driver reset, a sleeping laptop). The plain moons are drawn then, and a new
 * set is made a little later, a few times at most: a computer whose driver keeps failing is better off with the plain ones.
 */
const AGAIN_MS = [800, 4000, 15_000, 60_000]

let made: Promise<Characters | null> | undefined
let now: Characters | null = null
let lost = 0
const listeners = new Set<(c: Characters | null) => void>()

const tell = (c: Characters | null) => {
  now = c
  for (const on of [...listeners]) on(c)
}

function make(): Promise<Characters | null> {
  let mine: Characters | null = null
  const onLost = () => {
    if (now !== mine) return
    tell(null)
    mine?.dispose()
    made = Promise.resolve(null)
    const wait = AGAIN_MS[lost++]
    if (wait !== undefined) setTimeout(() => void (made = make()), wait)
  }
  return createCharacters(onLost)
    .catch(() => null)
    .then((c) => {
      mine = c
      tell(c)
      return c
    })
}

export const getCharacters = (): Promise<Characters | null> => (made ??= make())

/** The characters once they are ready. Null until then, while they are being made again, and where they cannot be drawn. */
export function useCharacters(): Characters | null {
  const [characters, setCharacters] = useState<Characters | null>(now)
  useEffect(() => {
    listeners.add(setCharacters)
    void getCharacters()
    setCharacters(now)
    return () => {
      listeners.delete(setCharacters)
    }
  }, [])
  return characters
}
