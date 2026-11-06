<p align="center">
  <img src="media/icon.png" alt="Remote SSH Password Memory icon" width="128" height="128">
</p>

<h1 align="center">Remote SSH Password Memory</h1>

<p align="center">Remember fixed SSH passwords in VS Code. Keep using Microsoft Remote-SSH.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/compatibility.md">Compatibility</a> ·
  <a href="docs/troubleshooting.md">Troubleshooting</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="docs/README.zh-CN.md">Simplified Chinese guide</a>
</p>

A Windows x64 companion extension for [Microsoft Remote-SSH](https://code.visualstudio.com/docs/remote/ssh). Enter a password in VS Code, choose whether to remember it, and reconnect without typing it again. OpenSSH still handles the connection, server identity checks, terminals, and forwarding.

> **Preview 0.1.4.** Local OpenSSH loopback tests pass. Real VS Code UI, SecretStorage persistence across restarts, and the complete Remote-SSH server installation still need acceptance testing. This preview supports one exact OpenSSH build. Read the [compatibility requirements](docs/compatibility.md) and [test report](docs/testing/2026-11-06.md) before installing.

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

See [supported builds and fallback behavior](docs/compatibility.md). The native bridges are unsigned local builds. This project is independent of Microsoft.

### Install and connect

1. Download a Windows x64 package from [GitHub Releases](https://github.com/Gerard-Devlin/RemoteSSH-password/releases), or build from source. The current package is `remote-ssh-password-memory-0.1.4-win32-x64.vsix`.
2. In the local Extensions view, choose **Install from VSIX…** and select that file. Ensure Microsoft Remote-SSH is installed.
3. Run **SSH Password Memory: Enable** from the Command Palette and confirm the two setting changes.
4. Use **Remote-SSH: Connect to Host…** as usual. Verify any first-time server fingerprint before accepting it.
5. Enter the password in the masked VS Code input. Choose **Remember on This Device** or **Use Once**.
6. After successful authentication, use **Manage Saved Passwords** to inspect the destination and fingerprint. Passwords are never displayed.

Or install a locally built package from the repository root:

```powershell
code --install-extension ./artifacts/remote-ssh-password-memory-0.1.4-win32-x64.vsix
```

Installing the extension does not enable password memory. Preview VSIX packages are available from GitHub Releases; there is no Marketplace listing, telemetry, or automatic update service.

## Commands

Open the Command Palette with **Ctrl+Shift+P**. Commands appear under **SSH Password Memory**, with localized titles when Simplified Chinese is selected.

| Command                          | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Enable                           | Review and enable password memory.                                                 |
| Manage Saved Passwords           | List saved destinations and fingerprints; select one to delete its saved password. |
| Delete Saved Password            | Remove a selected saved credential.                                                |
| Disable and Restore SSH Settings | Stop password memory and restore settings still owned by the extension.            |
| Show Diagnostics                 | Show platform, local SSH helper path, and service status without passwords.        |

Command IDs remain stable across languages; see the [contributor guide](CONTRIBUTING.md).

## Language

The extension uses VS Code's [native localization](https://github.com/microsoft/vscode-l10n). English is the default; **Simplified Chinese (`zh-cn`)** is included. Use **Configure Display Language** and restart VS Code to switch. Command titles, input boxes, choices, confirmations, and diagnostics follow that language.

Authentication challenges and fingerprint values are kept verbatim. Standard server-trust requests use localized server, key-type, and fingerprint details; unrecognized requests retain the original OpenSSH text. There is no separate extension language setting. The main repository documentation is in English; a [Chinese quick-start guide](docs/README.zh-CN.md) is available separately.

## Settings and removal

Enabling writes exactly two user settings:

| Setting                     | Value while enabled                                                     |
| --------------------------- | ----------------------------------------------------------------------- |
| `remote.SSH.path`           | The stable `bridge-v1/ssh.exe` path in this extension's global storage. |
| `remote.SSH.useLocalServer` | `true`                                                                  |

Original values are recorded in local state and a password-free `recovery.json`. Other settings and your SSH config remain intact.

Before uninstalling, forget credentials you want removed, then run **Disable and Restore SSH Settings**. Disabling preserves saved credentials. Direct uninstallation relies on the retained bridge for ordinary OpenSSH fallback; manual deletion of global storage can break that path. Follow the [recovery instructions](docs/troubleshooting.md#restore-remote-ssh-after-removal) if necessary.

## Security and scope

Passwords use `ExtensionContext.secrets` rather than a custom password file. Managed authentication transports answers through memory and restricted local pipes, not command-line arguments, environment variables, or temporary text files. Server fingerprint checks stay enabled; new or changed fingerprints are never silently trusted.

Only clearly recognized, fixed-password authentication can be remembered. Other challenges require manual input. This cannot protect secrets from malware already controlling your Windows account. Read the [security model](SECURITY.md) for identity checks, local transport, memory limitations, and reporting guidance.

## Documentation

| Guide                                                  | Contents                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [Compatibility](docs/compatibility.md)                 | Exact supported build, unsupported modes, and fallback.                 |
| [Troubleshooting](docs/troubleshooting.md)             | Diagnostics, password failures, disable/uninstall, and manual recovery. |
| [Architecture](docs/architecture.md)                   | Extension, broker, SSH/SCP, and ASKPASS responsibilities.               |
| [Testing](docs/testing.md)                             | Test layers, commands, and manual acceptance checklist.                 |
| [Latest local test report](docs/testing/2026-11-06.md) | Reproducible evidence and remaining gaps.                               |
| [Contributing](CONTRIBUTING.md)                        | Development, translations, repository layout, and release checklist.    |
| [UI text guide](docs/ui-text.md)                       | Reviewed screens, shared terms, and localization conventions.           |
| [Changelog](CHANGELOG.md)                              | Version history.                                                        |

## Development

Requires Windows x64, Node.js 22+, npm, and Go 1.24+. GCC is needed only for Go's race detector.

```powershell
npm ci
npm run check
npm run package
npm run verify:package
```

The [contributor guide](CONTRIBUTING.md) covers loopback integration tests, isolated VS Code testing, and packaging. Generated binaries, VSIX files, and local test profiles are excluded from source control. Source and issue links point to the GitHub repository. The existing `local-tools` publisher is for this local preview; Marketplace publication is not configured.

## License

[MIT](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/LICENSE). Native dependency licenses are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
