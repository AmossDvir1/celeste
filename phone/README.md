# Celeste for Android

Use Celeste on your computer from your Android phone, on the same Wi-Fi: your chats, live replies, a new chat, and Approve or Deny
for what the assistant asks, also as notifications with the app closed. The plan is in `docs/PHONE_PLAN.md`; the protocol is
`src/shared/phone.ts`.

It is a Capacitor 8 app. The screens are React (this folder's `src`), and they reuse the desktop's protocol, types and event reducer
from `../src`. The Android project is `android/`, with three pieces of Java of its own:

- `CelesteNativePlugin`: finds Celeste on the Wi-Fi (mDNS `_celeste._tcp`), reads the phone's name, starts and stops the service.
- `ConnectionService`: "Stay connected". Android pauses the app's web view in the background, so this keeps its own encrypted line
  to the computer and shows approvals and questions as notifications.
- `ApprovalReceiver`: Approve or Deny pressed on a notification, sent straight to the computer.

## Build

Needs Node 22+, the Android SDK (`ANDROID_HOME`) and Java 21 (the one in Android Studio is found by itself).

```
npm install          # in this folder
npm run apk          # web build, sync, then android/app/build/outputs/apk/debug/app-debug.apk
node scripts/icons.mjs   # only when the logo changes
```

Celeste on the computer hands that APK to phones: Settings, Phone, then scan the QR code. In development it finds the debug build
in this folder by itself.

## Try it

- In a browser: `npm run dev`, then type the address Celeste shows in Settings, Phone.
- Against the real desktop app: `npm run verify:phone` in the main folder pairs, chats, starts a chat and approves a command from
  the phone app, with a stand-in for Anthropic's API (no account).
- On an emulator: the emulator cannot see the computer's mDNS, so type `10.0.2.2:<port>`.

## Notes

- Debug builds allow Chrome DevTools on the web view (`chrome://inspect`).
- Phones whose Android System WebView is older than version 133 have no X25519 in WebCrypto; the app then uses `@noble/curves`.
- Pairing keys live in the web view's storage, and the service's shared key in the app's private preferences. Android Keystore is
  a later step.
