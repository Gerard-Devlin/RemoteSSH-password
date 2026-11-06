# Troubleshooting and recovery

[Back to README](../README.md)

## Update from an earlier preview

Install the new VSIX and reload the local VS Code window. If password memory was already enabled, run **Disable and Restore SSH Settings**, then **Enable** once to refresh the deployed local SSH helpers. Saved passwords are retained.

## Start with diagnostics

Run **SSH Password Memory: Show Diagnostics** from a local window. Inspect the platform, enabled state, bridge path, and broker status. The bridge directory’s password-free `bridge.json` records the real SSH path and its expected hash. Diagnostics contain metadata, not passwords. Review hostnames, usernames, and local paths before sharing them.

The [compatibility guide](compatibility.md) lists the exact supported executable. A matching `ssh -V` string is not enough. Unknown builds intentionally fall back to ordinary authentication; do not remove the hash check to force password memory.

## Passwords are still requested

- Ensure **Enable** completed in the local VS Code window and Microsoft Remote-SSH is installed.
- Check `remote.SSH.path` and `remote.SSH.useLocalServer` against diagnostics.
- Confirm this is a supported direct fixed-password connection. OTP, key passphrases, keyboard-interactive, and ambiguous prompts are never remembered.
- **Use once** does not save a password. **Remember on this device** saves only after successful password authentication.
- A changed target, username, port, fingerprint, or host-key algorithm can require fresh input.
- A different VS Code profile/user-data directory has separate storage. A window reload or unavailable broker can cause ordinary authentication fallback.

If an old password is rejected, it is not repeatedly offered automatically in the same connection. Enter the replacement when prompted; it is saved only after success. Network loss or a timeout alone does not mark a saved password as wrong.

## A password prompt says the response will not be saved

This is the manual-authentication path. The original server request appears as the masked input’s placeholder, with a short localized explanation below it. A challenge named Password can still be keyboard-interactive; this preview remembers only verified authentication using SSH’s password method. It does not infer a cacheable password from the challenge text.

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
2. Locate the extension's `bridge-v1/recovery.json`, using the diagnostic path or the current `remote.SSH.path`. The record contains original settings, not passwords.
3. If `remote.SSH.path` still points into `bridge-v1`, restore `original.path`. If it was originally unset, remove that setting.
4. If `remote.SSH.useLocalServer` still equals the installed value `true`, restore its recorded original value, or remove it if originally unset. Preserve any later edits.
5. If the recovery record is unavailable, choose a real SSH executable whose existence you have checked, such as `C:/Windows/System32/OpenSSH/ssh.exe`.
6. Run **Developer: Reload Window** and reconnect using ordinary Remote-SSH.

A typical standard-install storage location is:

```text
%APPDATA%\Code\User\globalStorage\local-tools.remote-ssh-password-memory\bridge-v1
```

Profiles, portable mode, and custom `--user-data-dir` values can change this location. In settings JSON, use forward slashes or escaped backslashes for Windows paths.

## VS Code is updating

If isolated host testing reports `vscode-updating is held` or says Code is currently being updated, let the update finish. Do not force-release its mutex or kill the updater. This blocks host testing before UI and SecretStorage assertions; it is not a successful test run.

## Report a problem

Include extension/VS Code/Remote-SSH versions, display language, real SSH version and hash, reproduction steps, and sanitized diagnostics. State whether the problem occurs with ordinary Remote-SSH after disabling this extension. Never include a password, raw IPC dump, unredacted SSH config, or production known_hosts file. See [SECURITY.md](../SECURITY.md) for sensitive reports.
