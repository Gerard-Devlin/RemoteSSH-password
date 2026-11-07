# Testing

[Back to README](../README.md) · [Latest local report](testing/2026-11-07.md)

## Test layers

| Layer                       | What it exercises                                                                                                | What it does not prove                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| TypeScript unit tests       | Credential state machine, persistence/rejection/revocation, matching, settings restoration.                      | Real UI, OS secret storage, or SSH transport.                           |
| Go unit tests               | SSH parsing, logging contract, stream filtering, environment, pipe helpers.                                      | A full Remote-SSH connection.                                           |
| Localization checks         | English/Chinese manifest and runtime key parity, placeholders, stable commands, unchanged raw prompts.           | VS Code's actual locale loader or visual layout.                        |
| Documentation checks        | Local Markdown/HTML links, icon reference, version consistency, core repo files.                                 | External link availability or hosted CI execution.                      |
| OpenSSH loopback            | Real pinned SSH/SCP, native bridge/broker, SSH/SFTP fixture, credential core with in-memory storage/UI adapters. | Actual VS Code SecretStorage or a production server.                    |
| Extension-entry integration | Compiled extension plus native bridge and real SSH, separately in English/Chinese.                               | Real VS Code API/UI/SecretStorage; these are mocked.                    |
| Isolated host               | Real VS Code activation, command registration, SecretStorage between two processes.                              | Complete interactive Remote-SSH acceptance or visually checked prompts. |
| Manual acceptance           | Real local VS Code and a controlled server across the full workflow.                                             | Broader support for untested versions/platforms.                        |

## Run locally

```powershell
npm ci
npm run check
npm run test:integration
npm run test:extension
npm run test:race
npm run package
npm run verify:package
```

Run `go vet ./...` from `native/` as well. Race detection requires GCC. Dependencies and compiler versions are recorded in the [dated report](testing/2026-11-07.md).

Loopback fixtures bind only to `127.0.0.1`. They use generated synthetic passwords and in-memory host keys, separate SSH config/known_hosts, and temporary SFTP data. They never connect to a user server or change real VS Code settings. Runtime fixture data remains in ignored directories for inspection; never upload it without reviewing metadata.

Result JSON is written under ignored `artifacts/`: `integration-results.json`, `extension-results-en.json`, and `extension-results-zh-cn.json`. These files are not packaged. Do not count a test layer as passing without executing it.

## Isolated VS Code host

```powershell
npm run build
npm run test:host -- -Code "C:/path/to/Microsoft VS Code/Code.exe"
```

The script creates separate user-data/extensions directories, copies the installed dependency versions needed by the fixture, and launches seed/verify/disabled phases. Use `-ExtensionSource` if installed dependencies are elsewhere. The currently expected dependency folders are Remote-SSH 0.128.0, Remote-SSH Edit 0.87.0, and Remote Explorer 0.5.0.

The fixture wraps the production entry in a disposable test copy and accesses that copy’s actual extension-context SecretStorage. Seed and verify use the same publisher/name but different manifest versions, installation paths, and native helper-generation paths. A third process verifies that an explicit disable remains off. It launches normal isolated VS Code processes: the standard `--extensionTestsPath` mode intentionally uses in-memory application storage and cannot prove cross-process persistence. The wrapper is excluded from the shipped VSIX.

This checks automatic setup, commands, real encrypted interactive-password persistence, generation upgrades, deletion, and persistent disable. It does not automate the interactive password/fingerprint workflow or a complete Remote-SSH connection. If VS Code is updating, wait for it to finish rather than forcing a lock release. See the latest report for the executed host version and results.

## CI

The three-platform workflow runs formatting, compilation, unit/localization/docs tests, native static analysis, loopback and bilingual extension-entry integration when the platform OpenSSH meets the contract, exact-inventory package verification, native architecture checks, and distribution receipts. A runner that cannot exercise a supported OpenSSH build says **not run** explicitly; it cannot silently become a successful integration claim.

CI does not install or interact with a real VS Code host. See the repository’s Actions page for executed checks. The distribution workflow consumes only successful main-branch push checks, verifies their package receipt, and creates non-overwriting GitHub Release assets. Automatic main-branch distribution is preview-only; a stable release requires the explicit manual workflow in the [publishing guide](marketplace.md#stable-releases).

## Manual acceptance

Use a controlled test server. Enter passwords only in VS Code's masked input. Repeat UI checks with English and Simplified Chinese display languages.

- [x] First trust shows the original fingerprint; rejecting sends no password. Verified by native and extension-entry integration.
- [x] Fixed-password input is masked; persistence choices and cancellation are correctly localized. Verified in English and Simplified Chinese.
- [x] Save only after successful password authentication; a failed attempt never creates a saved credential.
- [x] Restart/reconnect uses actual SecretStorage without another password input. Verified by isolated host and real-host acceptance.
- [x] Use Once requires input on a later new connection.
- [x] Manage/Forget shows metadata, removes the selected credential, and invalidates delayed pending saves.
- [x] Same host with different users/ports remains isolated.
- [x] Wrong/changed password prompts after at most one automatic saved offer.
- [x] Disconnect, timeout, cancel, reload, multiple real windows, and reconnection behave as documented. macOS real two-window acceptance included former native-askpass regressions.
- [x] SSH resolution activates the local extension before the remote host is available.
- [x] SCP/SFTP, PTY, and local forwarding work through the bridge with real OpenSSH.
- [x] Changed host keys are rejected; later legitimate changes do not reuse the old fingerprint's password.
- [x] Chinese and shell-special characters pass without shell escaping; sanitized output and runtime files contain no test secret.
- [x] Disable restores only owned settings; direct disable/uninstall fallback is covered by isolated host and native tests.
- [x] Missing helper and global-state recovery paths are covered by automated setup tests.

First installation on a brand-new external host, remote extension installation, and visually exhaustive OS-specific rendering remain Remote-SSH interoperability checks rather than password-memory release gates. The supported password-memory workflow above is closed for the 1.0.0 candidate.

Do not modify a production host key, lower host-key verification, or post passwords to complete this checklist. Keep incomplete items visible in the release report.
