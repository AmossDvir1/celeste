# Privacy

Celeste is a program that runs on your computer. **There is no Celeste server.** Nothing you type, no file, and no usage information is sent to the people who make Celeste, and Celeste has no account system, no analytics and no crash reporting.

## What stays on your computer

Your chats and their history, your workflows and their runs, your settings, the files an assistant makes in a chat, copies Celeste keeps so you can go back to an earlier state of a project, and the tools and devices you add are stored in Celeste's data folder on your computer (on Windows `%APPDATA%\Celeste`, on a Mac `~/Library/Application Support/Celeste`). Keys and passwords you give Celeste are kept in your operating system's secure storage and are never shown back.

## What leaves your computer, and where it goes

Celeste sends things only when you ask it to, and only to these:

- **The AI vendor you connect** (Anthropic for Claude, GitHub for Copilot). When you talk to an assistant, your messages, the files you attach and what the assistant reads while it works go to that vendor, from your computer, under your own account with them and their terms and privacy policy. Celeste does not see or keep a copy anywhere else.
- **npm (registry.npmjs.org)**, the first time you connect Claude or Copilot, to download that vendor's program (and a checksum to verify it). Nothing about you is sent.
- **GitHub (api.github.com)**, only if you choose "Check for updates" in Settings, to ask which version is newest. Nothing about you is sent beyond what any web request carries (your address).
- **Whatever a workflow or a tool you add contacts.** A workflow can call web addresses, run commands and use tools that you or someone who shared it with you wrote; you are shown all of it before a run, and you decide.
- **Devices you add** (a virtual machine, another computer, a phone): commands and files go to them over SSH or the phone's debugging connection, only when you let an assistant use them.

## Workflows you share

A shared workflow file holds the steps and nothing about your computer. Celeste leaves out the value of headers that look like secrets and the devices you used, but a command or a prompt you wrote is part of the file: read it before you share it.

## Questions or problems

Open an issue at https://github.com/AmossDvir1/celeste/issues, or see `SECURITY.md` for how to report a vulnerability privately.
