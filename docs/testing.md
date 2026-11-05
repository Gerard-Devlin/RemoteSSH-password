# Testing

[Back to README](../README.md) · [Latest local report](testing/2026-11-05.md)

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

Run `go vet ./...` from `native/` as well. Race detection requires GCC. Dependencies and compiler versions are recorded in the [dated report](testing/2026-11-05.md).

Loopback fixtures bind only to `127.0.0.1`. They use generated synthetic passwords and in-memory host keys, separate SSH config/known_hosts, and temporary SFTP data. They never connect to a user server or change real VS Code settings. Runtime fixture data remains in ignored directories for inspection; never upload it without reviewing metadata.

Result JSON is written under ignored `artifacts/`: `integration-results.json`, `extension-results-en.json`, and `extension-results-zh-cn.json`. These files are not packaged. Do not count a test layer as passing without executing it.

## Isolated VS Code host

```powershell
npm run build
npm run test:host -- -Code "C:/path/to/Microsoft VS Code/Code.exe"
```

The script creates separate user-data/extensions directories, copies the installed dependency versions needed by the fixture, and launches seed/verify phases. Use `-ExtensionSource` if installed dependencies are elsewhere. The currently expected dependency folders are Remote-SSH 0.128.0, Remote-SSH Edit 0.87.0, and Remote Explorer 0.5.0.

The fixture exercises activation, commands, and actual SecretStorage. It does not automate the interactive password and fingerprint workflow. If VS Code is updating, wait for it to finish rather than forcing a lock release. The latest recorded attempts were blocked before the assertions ran.

## CI

The Windows workflow runs formatting, compilation, unit/localization/docs tests, native static analysis, and package verification. It conditionally runs loopback and bilingual extension-entry integration when the runner's OpenSSH hash matches the pinned build. Otherwise a dedicated step and summary explicitly say **not run**. Hash checks remain enabled in both production and tests.

CI does not install or interact with a real VS Code host. The workflow has been prepared locally; successful execution on GitHub is not claimed until the repository is pushed and Actions actually runs.

## Manual acceptance

Use a controlled test server. Enter passwords only in VS Code's masked input. Repeat UI checks with English and Simplified Chinese display languages.

- [ ] First trust shows the original fingerprint; rejecting sends no password.
- [ ] Fixed-password input is masked; persistence choices and cancellation are correctly localized.
- [ ] Save only after successful password authentication; a failed attempt never creates a saved credential.
- [ ] Fully exit/restart VS Code and reconnect using actual SecretStorage without another password input.
- [ ] Use Once requires input on a later new connection.
- [ ] Manage/Forget shows metadata, removes the selected credential, and invalidates delayed pending saves.
- [ ] Same host with different users/ports remains isolated.
- [ ] Wrong/changed password prompts after at most one automatic saved offer.
- [ ] Disconnect, timeout, cancel, reload, multiple real windows, and reconnection behave as documented.
- [ ] SSH resolution activates the local extension before the remote host is available.
- [ ] First VS Code Server installation, actual SCP upload, remote extensions, terminals, and forwarding work.
- [ ] Changed host keys are rejected; later legitimate changes do not reuse the old fingerprint's password.
- [ ] Chinese and shell-special characters pass without shell escaping; inspect sanitized outputs/files/arguments for leaks.
- [ ] Disable restores only owned settings; direct disable/uninstall falls back where documented.
- [ ] Manual global-storage removal can be recovered using the documented path restoration.

Do not modify a production host key, lower host-key verification, or post passwords to complete this checklist. Keep incomplete items visible in the release report.
