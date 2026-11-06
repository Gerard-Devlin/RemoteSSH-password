<p align="center">
  <img src="https://raw.githubusercontent.com/Gerard-Devlin/RemoteSSH-password/main/media/icon.png" alt="Remote SSH Password Memory icon" width="128" height="128">
</p>

<h1 align="center">Remote SSH Password Memory</h1>

<p align="center">Remember fixed SSH passwords in VS Code. Keep using Microsoft Remote-SSH.</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Devlin.remote-ssh-password-memory">Install from Marketplace</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/compatibility.md">Compatibility</a> ·
  <a href="https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/CONTRIBUTING.md">Contributing</a> ·
  <a href="https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/README.zh-CN.md">Simplified Chinese guide</a>
</p>

A Windows x64 companion extension for [Microsoft Remote-SSH](https://code.visualstudio.com/docs/remote/ssh). Enter a password in VS Code, choose whether to remember it, and reconnect without typing it again. OpenSSH still handles the connection, server identity checks, terminals, and forwarding.

> **Preview 0.1.7.** Local OpenSSH loopback and isolated VS Code SecretStorage restart tests pass. Complete interactive Remote-SSH installation and visual UI acceptance remain open. This preview supports one exact OpenSSH build. Read the [compatibility requirements](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/compatibility.md) and [test report](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/testing/2026-11-06.md) before installing.

## Features

- **Save after success.** A password is written to VS Code SecretStorage only after confirmed password authentication.
- **Remember or use once.** Each new password has an explicit persistence choice.
- **Match the actual destination.** Credentials use OpenSSH's effective host, port, and username, bound to a verified server fingerprint.
- **Recover from rejection.** A saved password is offered automatically at most once per connection. A rejected password prompts for a replacement.
- **Stay inside VS Code.** Native masked input, host-trust confirmation, credential management, and diagnostics. English and Simplified Chinese follow the display language.
- **Keep the Remote-SSH workflow.** SSH and adjacent SCP bridges support the connection and upload paths without modifying Microsoft's extension.
- **Restore settings.** Disabling restores settings only when they still contain values installed by this extension.

## Quick start

### Requirements

- Windows **x64**, using the local VS Code UI extension host.
- VS Code **1.144.0+**; the inspected Remote-SSH integration is **0.128.0**.
- Windows OpenSSH **9.5p2** with the exact supported binary hash. A matching version label alone is insufficient.
- A direct SSH connection using a fixed password. Jump hosts, OTP, and key-passphrase memory are outside this preview's scope.

See [supported builds and fallback behavior](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/compatibility.md). The native bridges are unsigned local builds. This project is independent of Microsoft.

### Moving from the local-tools preview

Restore the old extension’s SSH settings, uninstall it, and reload VS Code before installing the Devlin package. Saved passwords do not automatically move between extension identities. Follow the [migration guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/marketplace.md#migrate-from-the-local-tools-preview).

### Install and connect

1. Install [Remote SSH Password Memory](https://marketplace.visualstudio.com/items?itemName=Devlin.remote-ssh-password-memory) from the VS Code Marketplace. In the Extensions view, search for `Devlin.remote-ssh-password-memory` and check the publisher is **Devlin**.
2. Ensure Microsoft Remote-SSH is installed. For manual installation, download `remote-ssh-password-memory-0.1.7-win32-x64.vsix` from [GitHub Releases](https://github.com/Gerard-Devlin/RemoteSSH-password/releases) and choose **Install from VSIX…**.
3. Run **SSH Password Memory: Enable** from the Command Palette and confirm the two setting changes.
4. Use **Remote-SSH: Connect to Host…** as usual. Verify any first-time server fingerprint before accepting it.
5. Enter the password in the masked VS Code input. Choose **Remember on This Device** or **Use Once**.
6. After successful authentication, use **Manage Saved Passwords** to inspect the destination and fingerprint. Passwords are never displayed.

Or install a locally built package from the repository root:

```powershell
code --install-extension ./artifacts/remote-ssh-password-memory-0.1.7-win32-x64.vsix
```

Installing the extension does not enable password memory. Marketplace installations receive extension updates through VS Code, subject to your automatic-update settings. Manual VSIX packages remain available from GitHub Releases. The extension collects no telemetry.

## Commands

Open the Command Palette with **Ctrl+Shift+P**. Commands appear under **SSH Password Memory**, with localized titles when Simplified Chinese is selected.

| Command                          | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Enable                           | Review and enable password memory.                                                 |
| Manage Saved Passwords           | List saved destinations and fingerprints; select one to delete its saved password. |
| Delete Saved Password            | Remove a selected saved credential.                                                |
| Disable and Restore SSH Settings | Stop password memory and restore settings still owned by the extension.            |
| Show Diagnostics                 | Show platform, local SSH helper path, and service status without passwords.        |

Command IDs remain stable across languages; see the [contributor guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/CONTRIBUTING.md).

## Language

The extension uses VS Code's [native localization](https://github.com/microsoft/vscode-l10n). English is the default; **Simplified Chinese (`zh-cn`)** is included. Use **Configure Display Language** and restart VS Code to switch. Command titles, input boxes, choices, confirmations, and diagnostics follow that language.

Authentication challenges and fingerprint values are kept verbatim. Standard server-trust requests use localized server, key-type, and fingerprint details; unrecognized requests retain the original OpenSSH text. There is no separate extension language setting. The main repository documentation is in English; a [Chinese quick-start guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/README.zh-CN.md) is available separately.

## Settings and removal

Enabling writes exactly two user settings:

| Setting                     | Value while enabled                                                     |
| --------------------------- | ----------------------------------------------------------------------- |
| `remote.SSH.path`           | The stable `bridge-v1/ssh.exe` path in this extension's global storage. |
| `remote.SSH.useLocalServer` | `true`                                                                  |

Original values are recorded in local state and a password-free `recovery.json`. Other settings and your SSH config remain intact.

Before uninstalling, forget credentials you want removed, then run **Disable and Restore SSH Settings**. Disabling preserves saved credentials. Direct uninstallation relies on the retained bridge for ordinary OpenSSH fallback; manual deletion of global storage can break that path. Follow the [recovery instructions](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/troubleshooting.md#restore-remote-ssh-after-removal) if necessary.

## Security and scope

Passwords use `ExtensionContext.secrets` rather than a custom password file. Managed authentication transports answers through memory and restricted local pipes, not command-line arguments, environment variables, or temporary text files. Server fingerprint checks stay enabled; new or changed fingerprints are never silently trusted.

Only clearly recognized, fixed-password authentication can be remembered. Other challenges require manual input. This cannot protect secrets from malware already controlling your Windows account. Read the [security model](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/SECURITY.md) for identity checks, local transport, memory limitations, and reporting guidance.

## Documentation

| Guide                                                                                                                | Contents                                                                |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Compatibility](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/compatibility.md)                 | Exact supported build, unsupported modes, and fallback.                 |
| [Troubleshooting](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/troubleshooting.md)             | Diagnostics, password failures, disable/uninstall, and manual recovery. |
| [Architecture](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/architecture.md)                   | Extension, broker, SSH/SCP, and ASKPASS responsibilities.               |
| [Testing](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/testing.md)                             | Test layers, commands, and manual acceptance checklist.                 |
| [Latest local test report](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/testing/2026-11-06.md) | Reproducible evidence and remaining gaps.                               |
| [Contributing](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/CONTRIBUTING.md)                        | Development, translations, repository layout, and release checklist.    |
| [UI text guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/ui-text.md)                       | Reviewed screens, shared terms, and localization conventions.           |
| [Changelog](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/CHANGELOG.md)                              | Version history.                                                        |

## Development

Requires Windows x64, Node.js 22+, npm, and Go 1.24+. GCC is needed only for Go's race detector.

```powershell
npm ci
npm run check
npm run package
npm run verify:package
```

The [contributor guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/CONTRIBUTING.md) covers loopback integration tests, isolated VS Code testing, and packaging. Generated binaries, VSIX files, and local test profiles are excluded from source control. Source and issue links point to the GitHub repository. The extension is published under `Devlin`; the same verified Windows x64 package is also attached to each GitHub Release. Follow the [upload and migration guide](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/marketplace.md) when moving from the old `local-tools` preview.

For later updates, run `npm run version:patch` and push to main. See the [automatic publishing setup](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/docs/marketplace.md#one-time-automatic-publishing-setup) for the required Devlin Trusted Publishing policy and repository switch.

## License

[MIT](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/LICENSE). Native dependency licenses are listed in [THIRD-PARTY-NOTICES.txt](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/THIRD-PARTY-NOTICES.txt).
