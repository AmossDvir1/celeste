# Privacy

Celeste is a program that runs on your computer. **There is no Celeste server.** Nothing you type, no file, and no usage information is sent to the people who make Celeste, and Celeste has no account system, no analytics and no crash reporting.

## What stays on your computer

Your chats and their history, your workflows and their runs, your settings, the files an assistant makes in a chat, copies Celeste keeps so you can go back to an earlier state of a project, and the tools and devices you add are stored in Celeste's data folder on your computer (on Windows `%APPDATA%\Celeste`, on a Mac `~/Library/Application Support/Celeste`). Keys and passwords you give Celeste are kept in your operating system's secure storage and are never shown back.

## What leaves your computer, and where it goes

Celeste sends things only when you ask it to, and only to these:

- **The AI vendor you connect** (Anthropic for Claude, GitHub for Copilot). When you talk to an assistant, your messages, the files you attach and what the assistant reads while it works go to that vendor, from your computer, under your own account with them and their terms and privacy policy. Celeste does not see or keep a copy anywhere else.
- **npm (registry.npmjs.org)**, the first time you connect Claude or Copilot, to download that vendor's program (and a checksum to verify it). Nothing about you is sent.
- **GitHub (api.github.com)**, only if you choose "Check for updates" in Settings, to ask which version is newest. Nothing about you is sent beyond what any web request carries (your address).
- **GitHub (github.com releases)**, the first time you switch on Settings → Phone, to download the Android app of your version of Celeste (and its checksum), so your computer can hand it to your phone. Nothing about you is sent.
- **Whatever a workflow or a tool you add contacts.** A workflow can call web addresses, run commands and use tools that you or someone who shared it with you wrote; you are shown all of it before a run, and you decide.
- **Devices you add** (a virtual machine, another computer, a phone): commands and files go to them over SSH or the phone's debugging connection, only when you let an assistant use them.

## Celeste for Android (the phone app)

The phone app talks only to **your own computer**, directly over your Wi-Fi. There is no server in between, and everything between the two is encrypted end to end with keys made when you paired them (the computer's is kept in your operating system's secure storage, the phone's in the Android Keystore).

- **What the phone sends to your computer:** your messages and answers, the chats and workflows you open, and, only when you allow it on the phone each time, what an assistant asked for: your notifications, the phone's location, a calendar's events, the photos or files you pick, or the phone's screen while you let it control the phone.
- **What your computer does with it:** the same as with anything you type there. It goes to the AI vendor you use for that chat, as part of the conversation, and is kept in the chat's history on your computer. Files you pick on the phone are saved on your computer in Celeste's data folder (`phone/received`).
- **Phone control:** while you let an assistant use the phone (up to 15 minutes, or until you press Stop), what is on screen goes to your AI vendor, except in the apps on your never list and Celeste's fixed one (password managers, authenticators, Android's installer). It never types into a password field.
- **Nothing else:** the app has no analytics, no crash reporting and no account. Finding your computer uses your local network only (mDNS). Away from home it cannot reach your computer yet; if a relay is added for that, it will carry only encrypted messages, and this page will say what it sees.

## The browser inside Celeste

Celeste has a browser of its own. It works like any browser: the sites you open there see you as a visitor from this computer, and Celeste does not watch where you go or send it anywhere. It starts signed out and keeps no cookies after you quit unless you choose "Keep cookies".

- **When an assistant uses it** (you can switch that off in Settings; the first time it acts on a site that is not on your computer, it asks you), what it reads from a page, the pictures it takes of a page, and what it types go to your AI vendor as part of the chat, and stay in the chat's history on your computer. Close or avoid pages you do not want an assistant to read while it is working.
- **Other programs** (such as Playwright MCP) can use the browser only if you switch that on in Settings. It is off by default, listens on this computer only, and needs a secret address that changes each time Celeste starts.

## Workflows you share

A shared workflow file holds the steps and nothing about your computer. Celeste leaves out the value of headers that look like secrets and the devices you used, but a command or a prompt you wrote is part of the file: read it before you share it.

## Questions or problems

Open an issue at https://github.com/AmossDvir1/celeste/issues, or see `SECURITY.md` for how to report a vulnerability privately.
