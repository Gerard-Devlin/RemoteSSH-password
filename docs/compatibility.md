# Compatibility

[Back to README](../README.md)

## Preview baseline

| Component            | Baseline and evidence                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Platform             | Windows x64; local UI extension host only.                                                 |
| VS Code              | Minimum 1.144.0. Local installation inspected at 1.144.0; real-host acceptance is pending. |
| Microsoft Remote-SSH | Integration inspected at 0.128.0; other versions are unverified.                           |
| OpenSSH              | OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2, with the exact binary hash below.               |
| Authentication       | Direct connection using SSH's password method and a recognized standard user@host prompt.  |
| Language             | English fallback and Simplified Chinese (`zh-cn`).                                         |

Supported real `ssh.exe` SHA256:

```text
98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8
```

Inspect an existing system binary with:

```powershell
Get-FileHash -LiteralPath C:\Windows\System32\OpenSSH\ssh.exe -Algorithm SHA256
```

Do not obtain an untrusted executable just to match this value. A different build needs source-callsite validation and the full integration suite before it can be added to the allowlist.

## Why the exact build matters

Unmodified OpenSSH does not expose a public password-authentication success event. This preview uses selected, tested local LogVerbose callsites, a success packet, the active child PID, and host-verification state. It does not treat a zero exit code or arbitrary stderr text as authentication success.

Patch-specific source locations can change independently of the displayed version. TypeScript and Go therefore pin the binary hash. System updates may cause the bridge to revert to ordinary authentication until the new build is validated. This is intentional.

## Unsupported and manual modes

| Mode                                                                   | Behavior                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unknown OpenSSH binary/build                                           | Ordinary OpenSSH fallback; saved credentials are not read.                  |
| ProxyJump or ProxyCommand                                              | Passthrough; multi-hop password memory is not supported.                    |
| Non-strict host-key checking, including `no` and `accept-new`          | Passthrough.                                                                |
| Explicit `-E` log-file options                                         | Passthrough.                                                                |
| Key passphrases, keyboard-interactive, OTP, ambiguous prompts          | Manual input only in a managed connection; never remembered.                |
| Changed verified fingerprint                                           | No automatic saved-password offer. OpenSSH's host-key policy still applies. |
| macOS, Linux, Windows ARM64                                            | No native package in this preview.                                          |
| Host certificates, custom authentication modules, unusual target names | Outside the validation claim; persistence may be unavailable.               |

Managed connections suppress pre-authentication server banners to prevent spoofed diagnostic events. Post-login shell output is preserved, subject to the narrow diagnostic-filter limitation described in [SECURITY.md](../SECURITY.md). Use ordinary Remote-SSH if you must read a login banner.

## Credential matching

The target comes from real OpenSSH `-G` output, preserving SSH config precedence, including duplicate Host entries. Matching uses a lowercased hostname, exact port, case-sensitive username, and verified SHA256 host-key fingerprint. Different DNS names are not intentionally merged; a different host-key algorithm can conservatively require re-entry.

Window coordination is limited to the current Windows account and the same VS Code storage context. Profiles and separate user-data directories do not share credentials. See the [test report](testing/2026-11-06.md) for what has actually been exercised.
