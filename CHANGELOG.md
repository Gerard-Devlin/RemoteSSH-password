# Changelog

## 0.1.1 — 2026-11-06

- Add native VS Code localization with English fallback and Simplified Chinese for commands, authentication UI, management, confirmations, and diagnostics.
- Keep raw OpenSSH prompts and authentication behavior unchanged; add translation/placeholder checks and bilingual extension-entry integration coverage.
- Use the supplied project icon in the extension and README.
- Replace the main README with an English repository homepage; organize compatibility, recovery, architecture, testing, and dated evidence under docs.
- Add contributor guidance, issue/PR templates, isolated debug configurations, Windows CI, and version-derived packaging with expanded inventory verification.

This remains a local preview. Real VS Code UI, restart persistence, and complete Remote-SSH acceptance are pending.

## 0.1.0

Local Windows x64 preview. SecretStorage-backed password state machine, validated OpenSSH build, SSH/SCP/ASKPASS bridges, per-user named pipes, in-flight multi-window coordination, native VS Code input and credential commands, compare-and-restore settings, and offline loopback integration tests. Full real-server Remote-SSH acceptance remains pending.
