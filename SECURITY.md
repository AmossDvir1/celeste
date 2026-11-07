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

## How secrets are handled

Keys, tokens and device passwords are stored encrypted with the operating system (Electron `safeStorage`) in the main
process. The Core process never holds them at rest and asks for a device password only when it connects.
