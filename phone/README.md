# Celeste for Android

Use Celeste on your computer from your Android phone, on the same Wi-Fi: your chats, Develop, workflows, live replies, Approve or
Deny for what the assistant asks (also as notifications with the app closed), and the assistant using the phone when you allow it.
The plan is in `docs/PHONE_PLAN.md`; the protocol is `src/shared/phone.ts`.

It is a Capacitor 8 app. The screens are React (this folder's `src`), and they reuse the desktop's protocol, types and event reducer
from `../src`. The Android project is `android/`, with these pieces of Java of its own (`android/app/src/main/java/.../celeste`):

- `CelesteNativePlugin`: the bridge to the screens: finding Celeste on the Wi-Fi (mDNS `_celeste._tcp`), the phone's name, the
  service, abilities, the never list, shared text, and the Keystore-encrypted store.
- `ConnectionService`: "Stay connected". Android pauses the app's web view in the background, so this keeps its own encrypted line
  to the computer and shows approvals and questions as notifications.
- `Abilities`, `AbilityActivity`, `Cards`: what the assistant may ask the phone to do (notifications, open, alarm, location, photos and
  files, calendar, texts and calls), with a card for each request, in the app or as a notification.
- `PhoneControl`, `CelesteAccessibilityService`, `ControlReceiver`: phone control and its rails (a border and Stop on screen, the
  person's touch pauses it, a never list, no password fields).
- `SecureStore`, `PhoneLine`: the pairing and the line's key, encrypted with a key in the Android Keystore; the sealed line to the computer.

## Build

Needs Node 22+, the Android SDK (`ANDROID_HOME`) and Java 21 (the one in Android Studio is found by itself).

```
npm install          # in this folder
npm run apk          # web build, sync, then android/app/build/outputs/apk/debug/app-debug.apk
node scripts/icons.mjs   # only when the logo changes
```

The app's version is `package.json`'s here, kept the same as the main project's (a release checks it). CI builds the app on every
push, and a release signs it with the project's key (see `RELEASING.md` in the main folder).

Celeste on the computer hands that APK to phones: Settings, Phone, then scan the QR code. In development it finds the debug build in
this folder by itself; a released Celeste fetches the one attached to its release.

## Try it

- In a browser: `npm run dev`, then type the address Celeste shows in Settings, Phone.
- Against the real desktop app: `npm run verify:phone` in the main folder pairs, chats, starts a chat and approves a command from
  the phone app, with a stand-in for Anthropic's API (no account).
- On an emulator: the emulator cannot see the computer's mDNS, so type `10.0.2.2:<port>`.

## Notes

- Debug builds allow Chrome DevTools on the web view (`chrome://inspect`).
- Phones whose Android System WebView is older than version 133 have no X25519 in WebCrypto; the app then uses `@noble/curves`.
- The pairing (with the phone's private key) and the background line's key are stored encrypted with the Android Keystore. A pairing
  an older app kept in the web view's storage moves there at start.
