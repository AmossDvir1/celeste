# Making a release

A release is the installers for one version, on the [Releases page](https://github.com/AmossDvir1/celeste/releases), made by GitHub's own build machines from the code in this repository. **Nothing is published automatically**: the workflow makes a *draft*, and a person presses Publish.

## What is made

| File | For |
|---|---|
| `Celeste-<version>-windows-x64-setup.exe` | Windows 10 and 11, installs for the current user (no administrator rights), with a folder choice, Start menu entry and desktop shortcut |
| `Celeste-<version>-windows-x64-setup.msi` | The same, as an MSI for IT departments |
| `Celeste-<version>-mac-arm64.dmg` and `.zip` | Macs with Apple silicon |
| `Celeste-<version>-mac-x64.dmg` and `.zip` | Macs with an Intel processor |
| `Celeste-<version>.apk` | Celeste for Android, signed with the project's key (only when the Android signing secrets exist, below). A computer running this version fetches it from the release the first time phones are switched on, checks it against `SHA256SUMS.txt`, and hands it to phones on the Wi-Fi. `phone/package.json` must have the same version as `package.json` (the build checks). |
| `SHA256SUMS.txt` | A checksum for every file above |

Every one of them is started and looked inside by the build before it is offered (`scripts/installer-check.mjs`): on Windows it is installed silently, run (window, database, the terminal's pty), and uninstalled with the person's data left alone; on a Mac the packed app is run and checked the same way.

## The steps

1. **Everything is green on `main`.** The CI page shows the unit tests on three systems, the app checks on a Mac, and the installers for Windows and macOS.
2. **Set the version** in `package.json` (`"version": "1.0.0"`) and the same in `phone/package.json`, add a section `## [1.0.0] - date` to `CHANGELOG.md` (that section is the text of the release), run `npm run notices` if dependencies changed, and commit.
3. **Tag it and push the tag.** The tag must be `v` and the version:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   The *Release* workflow builds everything, refuses a tag that does not match `package.json`, and makes a **draft** release with the installers, the checksums and the notes from the changelog.
4. **Look at the draft.** Download an installer and try it. Read the notes.
5. **Press Publish** on the draft. That is the moment it becomes public.

To try the whole build without a tag (nothing is released; the installers are kept for two weeks as downloads of the run): *Actions → Release → Run workflow*.

## Making it on your own computer

```bash
npm ci
npm run dist:win        # on Windows: release/*.exe and release/*.msi
npm run dist:mac        # on a Mac:   release/*.dmg and release/*.zip
node scripts/installer-check.mjs   # installs (Windows) or opens (Mac) what was just made, and checks it
```

On Windows the first build may stop at "Cannot create symbolic link". That is the packager unpacking its signing tools without the right to make links; turn on **Developer Mode** (Settings → For developers), or run the build once as administrator.

## Signing (not set up yet)

Without signing, Windows SmartScreen and macOS Gatekeeper warn the first time (the README tells people what to do). Signing needs certificates that cost money and are tied to a person or an organisation, so it is a decision for the owner of the project. When they exist, add them as repository secrets and the workflow uses them without any other change:

| For | Secrets | Where from |
|---|---|---|
| Windows | `WINDOWS_CSC_LINK` (the certificate, as a file link or base64) and `WINDOWS_CSC_KEY_PASSWORD` | A code-signing certificate from a certificate authority (an EV one removes the SmartScreen warning at once; a standard one earns it over time). Free signing for open-source projects exists through programs such as SignPath: apply, then use their action instead of `CSC_LINK`. |
| Android | `ANDROID_KEYSTORE_BASE64` (the keystore file, base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Free: make it once with `keytool -genkeypair -v -keystore celeste.jks -keyalg RSA -keysize 4096 -validity 10000 -alias celeste`, then `base64 -w0 celeste.jks` for the first secret. **Keep the file and its passwords safe for good**: a new app signed with another key will not install over the old one, so everyone would have to uninstall first. Without these secrets the release has no APK (an unsigned one cannot be installed), and computers fall back to an APK built from source. |
| macOS | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` (a *Developer ID Application* certificate), `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | An Apple Developer Program membership (US$99 a year). With these the app is signed and notarized, and the Gatekeeper warning goes away. |

## Before the first public release

- The installers have been run on **Windows** here, by the build. They have not been opened by a person on a **Mac**; the build starts the app there but cannot judge how it looks or how the system treats it. Someone with a Mac should try the draft before it is published.
- `@anthropic-ai/claude-agent-sdk` (shipped inside Celeste) is under Anthropic's own terms, not an open-source licence. Celeste does not ship Claude Code's program, which is downloaded when someone connects Claude. Read [the terms](https://www.anthropic.com/legal/commercial-terms) and the note in `docs/IMPLEMENTATION_PLAN.md` (section 6.4) and be sure you are content with them before publishing.
