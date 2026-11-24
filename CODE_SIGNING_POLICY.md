# Code signing policy

**Status:** Celeste's Windows installers are **not signed yet**. The project is applying for free code signing from the [SignPath Foundation](https://signpath.org/). Until that is approved, the installers are unsigned, and the [README](README.md#get-celeste) says what Windows shows because of that. This page describes how signing will work, so that you can hold the project to it.

When signing is in place, this line will also appear on the project's home page and on every release:

> Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## What is signed

Only files that this project builds from its own source in this repository:

- the Windows installers of a release (`Celeste-<version>-windows-x64-setup.exe` and `.msi`),
- `Celeste.exe`, the program the installer installs, and the uninstaller.

Each is signed with the product name **Celeste** and the product version of the release.

## What is not signed by this project

- **Files that belong to other projects.** Celeste is an Electron app, so it contains Electron's and Chromium's own libraries, and the compiled parts of some open-source libraries. They keep their makers' own signatures, or none. Their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **The programs Celeste downloads when you connect an assistant** (Claude Code, GitHub Copilot's runtime, OpenAI's Codex, the Gemini CLI). They come from their makers through npm, are checked against the checksum npm publishes, and are not built from this repository.

## Who decides

Celeste has one maintainer so far, who holds all three roles:

| Role | What it means | Held by |
|---|---|---|
| **Author** | Changes the source without further review | [AmossDvir1](https://github.com/AmossDvir1) |
| **Reviewer** | Reviews every change that comes from someone else (a pull request) before it is merged | [AmossDvir1](https://github.com/AmossDvir1) |
| **Approver** | Approves each request to sign a release, after looking at the release | [AmossDvir1](https://github.com/AmossDvir1) |

If others join, this page is updated with them, and a change from someone who is not an Author is still reviewed by a different person before it is merged. Everyone with a role uses multi-factor authentication on GitHub and on SignPath.

## How a release is signed

1. A version is tagged, and the *Release* workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) builds the installers on GitHub's own build machines from the tagged source. Nothing built on a person's own computer is signed.
2. The unsigned files are sent to SignPath, which checks that they were built from this repository.
3. The Approver approves the signing request by hand. There is no automatic approval.
4. The signed files are attached to a **draft** release, which a person publishes after trying it.

The workflow builds from the repository's source and build scripts only, and does not work around the checks SignPath makes.

## Privacy

Celeste sends nothing to anyone unless you ask it to, and it has no analytics. What leaves your computer, and where it goes, is listed in [PRIVACY.md](PRIVACY.md): the assistant you connect, npm (to download that assistant's program), and the few other things that you switch on yourself. Installing Celeste adds a Start menu entry and a desktop shortcut, and uninstalling it (Settings → Apps → Celeste) removes them; your chats and settings stay in `%APPDATA%\Celeste` until you delete that folder.

## Checking a file

On Windows, right-click the installer, choose **Properties → Digital Signatures**, and look for the SignPath Foundation certificate. Every release also lists a checksum for each file in `SHA256SUMS.txt`.

## Problems

If you think a signed file is wrong or harmful, please [open an issue](https://github.com/AmossDvir1/celeste/issues). For a security problem, follow [SECURITY.md](SECURITY.md) instead. The project will help with any investigation that SignPath or Microsoft asks for.
