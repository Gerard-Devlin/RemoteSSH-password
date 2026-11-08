# Compatibility

[Back to README](../README.md)

## Supported baseline

| Component            | Baseline and evidence                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| Platform             | Windows x64 and macOS arm64/x64; local UI extension host only.                         |
| VS Code              | Minimum 1.73.0; compiled against that API.                                             |
| Microsoft Remote-SSH | Current integration inspected at 0.128.0. VS Code selects the newest compatible build. |
| OpenSSH              | Windows: exact profiles below. macOS: OpenSSH 9.0+ with LogVerbose support.            |
| Authentication       | Direct SSH password, or a verified single Password request using keyboard-interactive. |
| Language             | English fallback and Simplified Chinese (`zh-cn`).                                     |

The 1.73.0 floor is the release that made `vscode.l10n` available to extensions. The extension and its type definitions intentionally target that API floor, so newer editor APIs are not required. Remote-SSH has its own editor requirement and may require a newer VS Code release; Marketplace extension resolution installs the newest Remote-SSH version compatible with the running editor.

Supported Windows `ssh.exe` profiles:

| Profile                      | SHA256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Windows system OpenSSH 9.5p2 | `98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8` |
| Win32-OpenSSH 9.5p1          | `e41e50a22dffeae8bb13bce4cb47b6c4aa0de4cdecbd62ef79d5046adc05a8b1` |
| Win32-OpenSSH 9.8p2          | `edb93b2139ee59fbee2b8dc0ba9f929d7ecda64d47d61eb1029de1413dff3224` |
| Win32-OpenSSH 10.0p2         | `6890c128c86cc2c38aad9fcb32a82b851ff3d38c714a1f656b8e445d7cd5e1c6` |

Inspect an existing system binary with:

```powershell
Get-FileHash -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe -Algorithm SHA256
```

Do not obtain an untrusted executable just to match these values. Each profile binds the executable hash to a version marker and an exact LogVerbose callsite set. A different build needs source-callsite validation and the full integration suite before it can be added to the allowlist.

## macOS

Choose `darwin-arm64` for Apple Silicon VS Code or `darwin-x64` for Intel VS Code. The default client is `/usr/bin/ssh`, with its adjacent `/usr/bin/scp`. A configured client must report OpenSSH 9.0+ and accept LogVerbose. Each deployment records the actual client hash; changing that binary causes ordinary passthrough until validated again during activation.

macOS uses current-user-only Unix sockets and checks kernel peer UID/PID and executable paths through libproc. SSH diagnostic output streams through a private FIFO, separated from server stderr. No diagnostic text is written to a regular file. Server-controlled method-list log callsites are disabled. After any keyboard-interactive password rejection or partial continuation, remaining prompts in that connection stay manual; reconnect to remember a replacement fixed password.

## Why the exact Windows builds matter

Unmodified OpenSSH does not expose a public password-authentication success event. This release uses selected, tested local LogVerbose callsites, a success packet, the active child PID, and host-verification state. It does not treat a zero exit code or arbitrary stderr text as authentication success.

Patch-specific source locations can change independently of the displayed version. `native/windows-openssh.json` is the source of truth for exact executable hashes and callsite profiles. Generated TypeScript and embedded Go data therefore reject unknown hashes and profile/filter mismatches. System updates may still cause the bridge to revert to ordinary authentication until that new build is validated. This is intentional.

## Unsupported and manual modes

| Mode                                                                   | Behavior                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unknown OpenSSH binary/build                                           | Ordinary OpenSSH fallback; saved credentials are not read.                  |
| ProxyJump or ProxyCommand                                              | Passthrough; multi-hop password memory is not supported.                    |
| Non-strict host-key checking, including `no` and `accept-new`          | Passthrough.                                                                |
| Explicit `-E` log-file options                                         | Passthrough.                                                                |
| Key passphrases, OTP, ambiguous or additional interactive prompts      | Manual input only in a managed connection; never remembered.                |
| Changed verified fingerprint                                           | No automatic saved-password offer. OpenSSH's host-key policy still applies. |
| Linux, Windows ARM64                                                   | No native package in this release.                                          |
| Host certificates, custom authentication modules, unusual target names | Outside the validation claim; persistence may be unavailable.               |

Managed connections suppress pre-authentication server banners to prevent spoofed diagnostic events. Post-login shell output is preserved, subject to the narrow diagnostic-filter limitation described in [SECURITY.md](../SECURITY.md). Use ordinary Remote-SSH if you must read a login banner.

## Credential matching

The target comes from real OpenSSH `-G` output, preserving SSH config precedence, including duplicate Host entries. Matching uses a lowercased hostname, exact port, case-sensitive username, and verified SHA256 host-key fingerprint. Different DNS names are not intentionally merged; a different host-key algorithm can conservatively require re-entry.

Window coordination is limited to the current local account and the same VS Code storage context. Profiles and separate user-data directories do not share credentials. See the [current test report](testing/2026-11-09.md) for what has actually been exercised.
