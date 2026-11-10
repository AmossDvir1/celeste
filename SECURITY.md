# Security

Celeste runs commands and edits files on behalf of AI agents, and can connect to your other machines, so security
reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting: on the repository, open the **Security**
tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the impact you see.

## What is in scope

- Bypassing an approval (a command or edit that runs without the approval the session's mode requires).
- A device running commands outside its permission level, or reaching a chat it is not attached to.
- Leaking stored secrets (vendor keys, device passwords) from the main process.
- The local tool server (loopback only) accepting a request without its per-session token.
- Anything that lets a web page or another local program drive Celeste.
- The phone bridge (Settings → Phone): a phone that gets in without the person pressing Allow on the computer, a request answered for a phone that was not asked, a message accepted twice or from a removed phone, or a phone reaching a method outside its short list.
- Phone control and phone abilities: any way for the assistant to act on the phone without the person's approval there, to press the Stop or Continue buttons, to type into a password field, or to see an app on the never list.

## How secrets are handled

Keys, tokens and device passwords are stored encrypted with the operating system (Electron `safeStorage`) in the main
process. The Core process never holds them at rest and asks for a device password only when it connects. The one secret
Core makes itself, the key pair phones are paired with, is handed to the main process to be stored the same way. On the
phone, the pairing and the background line's key are stored encrypted with a key in the Android Keystore.

## How phones are connected

The phone bridge is off until switched on in Settings → Phone, listens only on the local network, and answers only private
addresses. A new phone is paired by comparing three pictures on both screens and pressing Allow on the computer; after that
every request and push is sealed (AES-GCM, with keys from X25519) and replays are refused. A phone can reach a short list of
methods only, never settings, sign-ins or devices, and Remove cuts it off at once. See `docs/PHONE_PLAN.md`, section 5.
