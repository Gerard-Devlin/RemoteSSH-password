# Security model

This is an experimental local companion, not an authentication provider or a replacement for OpenSSH. Password-based authentication remains less desirable than SSH keys or a managed authentication agent where those options are available.

## Secret handling

Only ExtensionContext.secrets stores credentials. The extension does not create a password file, export passwords, sync secret keys, or expose a read-by-name API. Credential keys hash the effective host/port/user tuple; stored values include the host fingerprint, password, candidate ticket and revocation revision. Credential-management UI displays metadata only. Persistent revocation markers contain random non-secret identifiers.

Passwords travel from a masked VS Code input to the extension host, broker stdio, user-restricted Windows named pipes, ASKPASS stdout and the OpenSSH process. They do not enter command-line arguments, environment variables, log output or temporary text files in the managed path. Environment variables carry only non-secret routing information. The test fixture supplies synthetic passwords through stdin, never a password file.

JavaScript strings and Go-managed memory cannot guarantee immediate zeroization. Plaintext can remain until garbage collection or in OS paging/crash dumps. This design does not protect against malware controlling the Windows account, debugger/admin access, malicious extensions with equivalent local capabilities, executable replacement by that account, or a compromised VS Code installation.

## Local transport

Production communication uses named pipes only; there is no listening TCP service. Pipe DACLs allow the current SID, remote clients are rejected by go-winio, and pipe endpoints validate their peer PID and executable image path. ASKPASS clients must descend from the active real SSH child. The broker creates the session identifier and fixes the resolved target at session creation. The extension never services arbitrary target lookups without a session opened by the bridge.

The bridge directory has a protected inheritable DACL for the current user. Executable-path validation is not code signing and is not a defense against same-account code substitution. An explicit but stale window route fails rather than choosing a different window. The ancestry fallback accepts only a broker whose extension-host parent is an ancestor of the calling bridge; it does not route through a common Explorer/shell ancestor.

Across windows, a user-restricted coordinator deduplicates only in-flight requests for the same effective target, fingerprint, authentication kind and rejection state. It retains no credential cache. Each participating connection must independently report successful authentication before its extension host may save an input authorized for persistence.

## Server identity and success detection

OpenSSH remains responsible for configuration expansion, crypto, host-key checks, network transport and forwarding. Unknown hosts require a user confirmation showing the server address, key type, and original fingerprint. Structured display requires the prompt fingerprint to match the active SSH session; unrecognized or mismatched requests show the original OpenSSH text. Changed keys are not auto-accepted. A saved credential with a different verified fingerprint is never auto-filled. ProxyJump/ProxyCommand and non-strict host-checking configurations are passthrough in this version.

The wrapper does not infer authentication success from SSH exit status: a remote command can fail after successful authentication. Nor does it trust an arbitrary stderr substring. It requires the selected local success-packet diagnostic and the selected authenticated-to callsite, with the active child's PID and host-verification state.

Windows OpenSSH 9.5p2 build SHA256 is pinned in both TypeScript and Go. Source-file/line LogVerbose filters select tested local callsites; QUIET suppresses server-controlled pre-authentication banners and broad method-list logs. This changes diagnostic verbosity and hides pre-auth banners. Managed diagnostics are streamed through memory, not SSH -E files. Unknown or upgraded SSH binaries fall back. Changing the allowlist requires revalidating the parser, callsites and spoofing tests, not just updating a version string.

The success path is intentionally narrow and not a general proof against all future OpenSSH logging changes. Host certificates, custom authentication modules and unusual target naming are not covered by the compatibility claim; they may result in manual prompts without persistence. After authentication, remote command output is never interpreted as further authentication state. Numeric packet diagnostics are filtered from outward output but continue to incur streaming-filter overhead for the life of the managed connection. After authentication an exact observed PID-tagged numeric log sequence is removed wherever OpenSSH inserts it, including inside a fragmented stderr write; remote output deliberately reproducing that exact sequence would also be filtered.

## Failure and lifecycle

One automatic saved-password offer per connection. Explicit rejection invalidates that candidate; disconnect/timeout alone does not. New passwords stay in memory until successful password authentication. A recognized, single Password prompt using keyboard-interactive can create a candidate only when the user selects Remember for a fixed server password. Exact pinned local callsites report prompt counts and partial success. Multiple fields, an additional prompt or partial-authentication continuation clear eligibility; OTP, key passphrases and unrecognized prompts remain manual. Stored records are bound to the successful authentication method; legacy records default to SSH password authentication. End/cancel/disable abort outstanding UI and clear candidates.

Forget writes a revocation revision before deleting the credential; delayed candidates from other windows are rejected or remain unusable if a write races deletion. SecretStorage does not offer atomic cross-process compare-and-swap: a narrow racing rejection can remove a newly written value, causing another manual prompt, not cross-target disclosure. For strongest immediate removal, cancel outstanding connections before forgetting. Already-delivered answers cannot be retracted.

Installation/activation automatically sets up the two Remote-SSH user settings after executable validation. Password persistence still requires the user’s Remember choice. Setup uses a current-user-restricted storage root, an exclusive process lock, immutable version/hash helper directories, and a password-free control journal. Explicit disable persists across reload; later user SSH-setting edits suspend automatic setup rather than being overwritten. Disabling restores only settings still equal to installed values. Direct uninstallation has no dependable VS Code callback; an intentionally retained stable bridge provides passthrough as long as its global storage and real SSH executable remain present. If those files are removed, manually restore the path as documented. No claim of automatic cleanup after user-data deletion is made.

## Release hygiene

The VSIX must contain only production compiled JS, ssh.exe/scp.exe/askpass.exe/broker.exe and documentation/licenses. Do not package testserver.exe, test profiles, runtime fixtures, source maps, npm dependencies or credentials. All four executables are the same basename-dispatched Go binary. They are locally built and unsigned; no Microsoft signature is implied. Native dependencies are covered by THIRD-PARTY-NOTICES.txt.

No production credentials were requested or used to develop this version. Reports should contain sanitized diagnostics only; never include passwords or raw IPC dumps. Before production use, complete the [manual acceptance checklist](docs/testing.md#manual-acceptance).

## Reporting a vulnerability

Do not include secrets or raw authentication traffic in a public issue. If the repository has private vulnerability reporting enabled, use its Security tab to submit a private advisory. Otherwise ask the maintainer for a private reporting channel without posting exploit details or credentials. This preview has no separate security contact or response-time guarantee.

Review scope and incomplete real-host validation in the [latest local report](docs/testing/2026-11-06.md).
