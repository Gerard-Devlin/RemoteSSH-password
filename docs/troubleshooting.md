# Troubleshooting and recovery

[Back to README](../README.md)

## Moving from the local-tools publisher

Version 0.1.5 uses publisher `Devlin`, creating a new extension identity. Restore settings and uninstall the old extension before installing the new one; follow the [migration guide](marketplace.md#migrate-from-the-local-tools-preview). Passwords are not automatically migrated.

## Enable reports that an old local-tools SSH helper is unsupported

A path ending in `globalStorage/local-tools.remote-ssh-password-memory/bridge-v1/ssh.exe` is a wrapper from the previous publisher. It is not the real OpenSSH binary. If the old extension was uninstalled first, this setting can remain while the wrapper and its recovery files have already been removed. Remote-SSH then shows its ordinary password box, and this extension cannot offer to remember anything.

Install the current release and reload the local window. Setup and known stale-path recovery now run automatically. The extension checks the real OpenSSH version/hash and SCP as usual. If no old recovery journal remains, disabling later keeps the verified real SSH program configured rather than restoring the deleted wrapper. Credentials are not read or transferred from the old publisher.

## Update from an earlier preview

Install the new VSIX and reload the local VS Code window. The extension automatically selects a complete new helper generation during upgrades. Saved passwords are retained. A deliberately disabled installation remains off.

## Start with diagnostics

Run **SSH Password Memory: Show Diagnostics** from a local window. Inspect the platform, enabled state, bridge path, and broker status. The bridge directory’s password-free `bridge.json` records the real SSH path and its expected hash. Diagnostics contain metadata, not passwords. Review hostnames, usernames, and local paths before sharing them.

The [compatibility guide](compatibility.md) lists the exact supported executable. A matching `ssh -V` string is not enough. Unknown builds intentionally fall back to ordinary authentication; do not remove the hash check to force password memory.

## Passwords are still requested

- Install Microsoft Remote-SSH in the local window and allow this extension to activate. Setup is automatic unless you previously turned it off or changed the managed SSH settings.
- Check `remote.SSH.path` and `remote.SSH.useLocalServer` against diagnostics.
- Confirm this is a supported direct fixed-password connection. Direct SSH passwords and a verified single interactive Password request are supported. OTP, key passphrases, multiple fields and extra interactive steps remain manual.
- **Use once** does not save a password. **Remember on this device** saves only after successful password authentication.
- A changed target, username, port, fingerprint, or host-key algorithm can require fresh input.
- A different VS Code profile/user-data directory has separate storage. A window reload or unavailable broker can cause ordinary authentication fallback.

If an old password is rejected, it is not repeatedly offered automatically in the same connection. Enter the replacement when prompted; it is saved only after success. Network loss or a timeout alone does not mark a saved password as wrong.

## A saved connection is listed, but a new input is requested

Updates with the same publisher and extension name keep the same SecretStorage namespace. The credential key does not contain the extension version or installation path. Reloading, disabling, and re-enabling do not delete saved passwords.

If a standard Remote-SSH password input appears only after updating or reloading, fully exit all VS Code windows and reopen before retrying. A detached Remote-SSH local server can retain an address for a previous authentication service. Re-enabling alone cannot replace the environment of an already running detached process. This is a troubleshooting step, not proof of the cause; keep the saved record while checking.

The list confirms that a credential is stored; it does not mean that every authentication request can use it. Open **Show Diagnostics** after reproducing the prompt:

- **A saved password was supplied for this connection.** The saved password was offered. If the server rejects it, enter a replacement.
- **No saved password matches this connection.** Check the effective host, port, and case-sensitive username, as well as the VS Code user-data directory.
- **This authentication request cannot use a saved password.** The current request is interactive, a key passphrase, or otherwise not eligible for password memory, even if its text says Password.
- A fingerprint warning means the server key differs from the saved record. Verify the server before entering anything; the extension does not bypass that check.

A success message in diagnostics confirms when a newly entered password was actually saved. A publisher change is a different extension identity; see the [migration guide](marketplace.md).

## A password prompt says the response will not be saved

This is the manual-authentication path. The original server request appears as the masked input’s placeholder, with a short localized explanation below it. Current releases can remember a verified single Password challenge over keyboard-interactive. This manual input instead indicates an OTP, passphrase, an additional field/step, or a request that could not be recognized as a fixed server password. It deliberately has no Remember menu. If a fixed Password request still follows this path, report sanitized diagnostics and the prompt shape, never the response.

## Cancel or forget

Cancel the input to stop that authentication attempt. To remove a saved value, run **Delete Saved Password** or select an entry in **Manage Saved Passwords**. The list displays metadata only.

Forget revokes pending saves so a delayed successful connection cannot silently restore an old credential. An answer already delivered to OpenSSH cannot be recalled; cancel outstanding connections as well when immediate removal is required.

## Disable before uninstalling

1. Forget any credentials you want deleted.
2. Run **SSH Password Memory: Disable and Restore SSH Settings**.
3. Disable or uninstall the extension.

Disabling preserves saved credentials. Uninstallation is not a credential-erasure guarantee. Settings are restored only if they still match values installed by the extension; your later edits are retained.

## Restore Remote-SSH after removal

VS Code has no dependable uninstall callback. The stable bridge is deliberately stored outside the versioned extension directory. If the extension is unavailable, it runs real OpenSSH without reading saved credentials, provided both the bridge and real OpenSSH still exist. An in-progress connection may fail; retry with ordinary authentication.

Deleting global storage, quarantining the bridge, or moving the real SSH executable can break fallback. Restore the path before deleting remaining bridge files:

1. Open **Preferences: Open User Settings (JSON)**.
2. Locate the extension's `bridge-v2/<version-hash>/recovery.json`, using the diagnostic path or the current `remote.SSH.path`. The record contains original settings, not passwords.
3. If `remote.SSH.path` still points into the helper directory, restore `original.path`. If it was originally unset, remove that setting.
4. If `remote.SSH.useLocalServer` still equals the installed value `true`, restore its recorded original value, or remove it if originally unset. Preserve any later edits.
5. If the recovery record is unavailable, choose a real SSH executable whose existence you have checked, such as `C:/Windows/System32/OpenSSH/ssh.exe`.
6. Run **Developer: Reload Window** and reconnect using ordinary Remote-SSH.

A typical standard-install storage location is:

```text
%APPDATA%\Code\User\globalStorage\devlin.remote-ssh-password-memory\bridge-v2\<version-hash>
```

Older local-tools previews keep their own recovery records under local-tools.remote-ssh-password-memory. Use the record associated with the currently configured SSH path.

Profiles, portable mode, and custom `--user-data-dir` values can change this location. In settings JSON, use forward slashes or escaped backslashes for Windows paths.

## VS Code is updating

If isolated host testing reports `vscode-updating is held` or says Code is currently being updated, let the update finish. Do not force-release its mutex or kill the updater. This blocks host testing before UI and SecretStorage assertions; it is not a successful test run.

## Report a problem

Include extension/VS Code/Remote-SSH versions, display language, real SSH version and hash, reproduction steps, and sanitized diagnostics. State whether the problem occurs with ordinary Remote-SSH after disabling this extension. Never include a password, raw IPC dump, unredacted SSH config, or production known_hosts file. See [SECURITY.md](../SECURITY.md) for sensitive reports.
