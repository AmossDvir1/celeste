// Runs the Android build (gradlew) with a Java that Capacitor 8 accepts (21 or newer). Uses JAVA_HOME when it is new
// enough, else the Java that comes with Android Studio. Usage: node scripts/gradle.mjs assembleDebug
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** The major version of the Java at `home`, or 0. */
const major = (home) => {
  if (!home || !existsSync(home)) return 0
  const r = spawnSync(resolve(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version'], { encoding: 'utf8' })
  const m = /version "(\d+)/.exec(`${r.stderr}${r.stdout}`)
  return m ? Number(m[1]) : 0
}

const candidates = [
  process.env.JAVA_HOME,
  'C:/Program Files/Android/Android Studio/jbr',
  '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/opt/android-studio/jbr'
]
const java = candidates.find((h) => major(h) >= 21)
if (!java) {
  console.error('The Android build needs Java 21 or newer. Install Android Studio, or set JAVA_HOME to a JDK 21.')
  process.exit(1)
}
const dir = resolve(import.meta.dirname, '..', 'android')
const gradlew = resolve(dir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const r = spawnSync(gradlew, process.argv.slice(2), { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, JAVA_HOME: java } })
process.exit(r.status ?? 1)
