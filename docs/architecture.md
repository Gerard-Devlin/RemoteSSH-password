# Architecture

[Back to README](../README.md)

## Components

| Component               | Responsibility                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript UI extension | Activation before SSH resolution, native localized prompts, persistence consent, SecretStorage, settings and lifecycle management.                                                     |
| Credential core         | Target/fingerprint matching, one saved offer per connection, successful-authentication commit, rejection and revocation handling.                                                      |
| Native broker           | Current-user-restricted named pipes, window/session routing, process binding, and in-flight prompt coordination.                                                                       |
| SSH bridge              | Resolve the real target with OpenSSH, start the real SSH child, scope ASKPASS variables to that child, observe validated authentication diagnostics, preserve streams and exit status. |
| ASKPASS helper          | Relay the active child's prompt and return its answer through pipes/stdout.                                                                                                            |
| SCP bridge              | Launch real SCP and direct its SSH transport through the adjacent SSH bridge.                                                                                                          |

The four platform helper executables are the same Go binary dispatched by filename. Production communication uses Windows named pipes or protected macOS Unix sockets, not a TCP listener. The isolated test server is a separate Go module and is never packaged.

## Connection and persistence

1. A local VS Code extension host activates on startup or SSH remote-authority resolution. Activation automatically validates/deploys the helper and records original settings. No setup dialog or command is required.
2. Remote-SSH invokes that bridge. Unsupported invocations/builds use ordinary OpenSSH fallback.
3. For a supported session, the bridge resolves host, port, and username using real OpenSSH. The broker fixes the session target and validates the participating process.
4. OpenSSH performs host-key checks. A recognized first-trust request shows localized server/key details, with the fingerprint matched to the active SSH session. Unrecognized requests retain the original OpenSSH text. Changed host keys are not silently accepted.
5. A verified fixed-password prompt may receive one matching saved value. Otherwise the UI requests a password and persistence choice. Other prompt kinds stay manual.
6. A new remembered candidate remains in memory until the active SSH child reports the validated successful password-authentication sequence. Only then may the owning extension host persist it.
7. Rejection, cancellation, disconnect, revocation, and disable clear or invalidate candidates according to the credential state machine. A network failure alone does not delete an old saved value.

## Windows, macOS and storage lifecycle

Each window owns its route. Remote-SSH's detached local-server process shares VS Code's instance identity with the extension host even though it is not a descendant. The bridge therefore matches that identity rather than requiring inherited environment state, and window-focus updates disambiguate multiple windows in the same VS Code process. An explicitly stale route may recover to a broker in the same VS Code instance; it never borrows a broker from another instance, and an unknown identity fails closed. A current-user coordinator merges only compatible in-flight requests for the same target/fingerprint/rejection state; it is not a native password cache.

Complete immutable `globalStorageUri/bridge-v2/<version-hash>` generations survive versioned extension replacement. All four adjacent executables share a generation; upgrades select a new directory while existing processes can finish with the old files. `control-v2.json` and a process lock coordinate automatic setup, explicit off/suspended intent, and safe settings restoration. `bridge.json` and `recovery.json` contain routing/configuration metadata, never passwords. SecretStorage holds credential values and revocation state. Credential records also identify the authentication method; older records remain compatible with SSH password authentication. Settings restoration compares current values before writing, preserving later user changes.

## Localization

Manifest contributions use `package.nls.json` and `package.nls.zh-cn.json`. Runtime UI uses English literal keys in `vscode.l10n.t` and the Simplified Chinese bundle in `l10n/`. VS Code loads the selected locale. Authentication challenges, target metadata, fingerprint values, and parser inputs are not translated. Recognized host-trust requests use localized labels around the original key details. Native helpers do not display a separate password UI.

See the [security model](../SECURITY.md) for the trust boundary, exact-build restrictions, and known limitations.

## macOS native boundary

macOS builds link libproc through cgo to validate actual executable paths. Unix socket peer UID/PID and process ancestry bind ASKPASS to the active SSH child and each SSH wrapper to its local window. Current-user-only socket directories use short paths under `/tmp`, independent of potentially long or Unicode profile paths.

The system SSH closes inherited extra descriptors. Its local diagnostics therefore use `-E` into a private FIFO, with a parent writer held until child exit to preserve EOF ordering. The FIFO reader uses blocking mode because Darwin kqueue does not signal FIFO writer closure reliably. Server stderr remains separate, and server-provided method-list callsites stay disabled.
