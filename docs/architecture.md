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

The four Windows executables are the same Go binary dispatched by filename. Production communication uses local named pipes, not a TCP listener. The isolated test server is a separate Go module and is never packaged.

## Connection and persistence

1. A local VS Code extension host activates on startup or SSH remote-authority resolution. Enable deploys a stable bridge and records original settings after explicit consent.
2. Remote-SSH invokes that bridge. Unsupported invocations/builds use ordinary OpenSSH fallback.
3. For a supported session, the bridge resolves host, port, and username using real OpenSSH. The broker fixes the session target and validates the participating process.
4. OpenSSH performs host-key checks. A recognized first-trust request shows localized server/key details, with the fingerprint matched to the active SSH session. Unrecognized requests retain the original OpenSSH text. Changed host keys are not silently accepted.
5. A verified fixed-password prompt may receive one matching saved value. Otherwise the UI requests a password and persistence choice. Other prompt kinds stay manual.
6. A new remembered candidate remains in memory until the active SSH child reports the validated successful password-authentication sequence. Only then may the owning extension host persist it.
7. Rejection, cancellation, disconnect, revocation, and disable clear or invalidate candidates according to the credential state machine. A network failure alone does not delete an old saved value.

## Windows and storage lifecycle

Each window owns its route. An explicitly stale route fails instead of choosing another window. A current-user coordinator merges only compatible in-flight requests for the same target/fingerprint/rejection state; it is not a native password cache.

The stable `globalStorageUri/bridge-v1` directory survives versioned extension replacement. `bridge.json` and `recovery.json` contain routing/configuration metadata, never passwords. SecretStorage holds credential values and revocation state. Settings restoration compares current values before writing, preserving later user changes.

## Localization

Manifest contributions use `package.nls.json` and `package.nls.zh-cn.json`. Runtime UI uses English literal keys in `vscode.l10n.t` and the Simplified Chinese bundle in `l10n/`. VS Code loads the selected locale. Authentication challenges, target metadata, fingerprint values, and parser inputs are not translated. Recognized host-trust requests use localized labels around the original key details. Native helpers do not display a separate password UI.

See the [security model](../SECURITY.md) for the trust boundary, exact-build restrictions, and known limitations.
