# Changelog

## Unreleased

## 0.1.9 — 2026-11-06

- Restore the original supplied artwork in the README header as a separate, unchanged image asset. Keep the resized Marketplace icon independent.

## 0.1.8 — 2026-11-06

- Recognize stale SSH helper paths from the local-tools preview instead of validating them as real OpenSSH programs.
- Recover original settings from a matching helper journal when present; otherwise, use a verified OpenSSH program and never restore a deleted helper path.
- Explain path recovery in the English and Chinese enable dialog. Keep the exact OpenSSH hash check, explicit setup consent, and credential namespaces unchanged.
- Cover missing legacy files, recovery metadata, safe restoration, and cancellation in regression tests.

## 0.1.7 — 2026-11-06

- Add the live Marketplace installation link and explain automatic extension updates in both language guides.
- Update the testing summary to distinguish passed isolated SecretStorage restart checks from pending interactive Remote-SSH acceptance.

## 0.1.6 — 2026-11-06

- Resize the supplied icon to 512 × 512 for Marketplace compatibility, preserving its artwork and transparency.
- Reject packaged icons outside the 128–1024 pixel square range during documentation and VSIX verification.
- Make upload failures point to the actual validation error as well as Trusted Publishing settings.

## 0.1.5 — 2026-11-06

- Add bilingual authentication diagnostics that distinguish a saved password being offered, a missing match, manual authentication, rejection, and a successful save.
- Test persisted credentials across runtime disposal and version/installation-path changes in an isolated VS Code profile.

- Set the registered publisher to Devlin, producing extension identity Devlin.remote-ssh-password-memory.
- Prepare the standard Windows x64 VSIX for manual Marketplace upload with absolute HTTPS README links/images and normal vsce link processing.
- Verify the packaged publisher, version, extension identity, platform, and exact production inventory. Update the isolated host fixture to discover the manifest identity.
- Add trusted-main CI distribution: immutable GitHub Releases, verified canonical VSIX artifacts, and opt-in Marketplace OIDC publishing. Add version update commands for future main-branch releases.
- Document migration from local-tools: restore settings, uninstall/reload the old extension, install the new one, and enter passwords again.

## 0.1.4 — 2026-11-06

- Review and unify every extension-owned English/Chinese dialog, input hint, button, password menu, error, and diagnostic message.
- Split enable and deletion confirmations into short titles and readable details; clarify that deleting a saved password changes only the local copy.
- Rename credential commands to Manage Saved Passwords and Delete Saved Password while preserving their command IDs. Show readable sign-in dates.
- Add actionable error dialogs and localized native SSH-path errors, with English fallback.
- Cover setup cancellation, unsupported SSH, storage errors, password retry, deletion cancellation, and native errors in bilingual extension-entry tests.

## 0.1.3 — 2026-11-06

- Replace the standard raw OpenSSH host-trust transcript with a concise English/Chinese dialog: server address, key type, exact fingerprint, and an explicit Trust and Connect button.
- Match displayed key details against the active SSH session; preserve the original OpenSSH request when it cannot be recognized safely.
- Keep first trust explicit and preserve OpenSSH host-key checks. Cover parsing and the bilingual dialog with unit and real OpenSSH extension-entry tests.

## 0.1.2 — 2026-11-06

- Separate the original server challenge from manual-authentication help: keep the request in the masked input placeholder and show a concise localized explanation below it.
- Localize the fixed-password placeholder and manual server-request label in English and Simplified Chinese.
- Preserve the existing rules for remembering passwords; keyboard-interactive and other manual challenges remain unsaved.
- Cover password-like keyboard-interactive prompts with real OpenSSH in both language variants of the extension-entry test.

## 0.1.1 — 2026-11-06

- Add native VS Code localization with English fallback and Simplified Chinese for commands, authentication UI, management, confirmations, and diagnostics.
- Keep raw OpenSSH prompts and authentication behavior unchanged; add translation/placeholder checks and bilingual extension-entry integration coverage.
- Use the supplied project icon in the extension and README.
- Replace the main README with an English repository homepage; organize compatibility, recovery, architecture, testing, and dated evidence under docs.
- Add contributor guidance, issue/PR templates, isolated debug configurations, Windows CI, and version-derived packaging with expanded inventory verification.

This remains a local preview. Real VS Code UI, restart persistence, and complete Remote-SSH acceptance are pending.

## 0.1.0

Local Windows x64 preview. SecretStorage-backed password state machine, validated OpenSSH build, SSH/SCP/ASKPASS bridges, per-user named pipes, in-flight multi-window coordination, native VS Code input and credential commands, compare-and-restore settings, and offline loopback integration tests. Full real-server Remote-SSH acceptance remains pending.
