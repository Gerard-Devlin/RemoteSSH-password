# Contributing

Thanks for helping improve Remote SSH Password Memory. Read the [compatibility contract](docs/compatibility.md) and [security model](SECURITY.md) before changing authentication or local IPC behavior.

## Development setup

Use Windows x64, Node.js 22+, npm, and Go 1.24+. The recorded local environment uses Node.js 24.13.1 and Go 1.26.1. Put Go on PATH. A GCC toolchain such as MinGW is required for race detection only; production native builds use `CGO_ENABLED=0`.

```powershell
npm ci
npm run check
npm run build
```

Run **Run Extension (English)** or **Run Extension (Simplified Chinese)** from the VS Code Run and Debug view. These launch configurations use separate development user-data directories. Install the matching Remote-SSH dependency into that isolated profile first, plus the Simplified Chinese Language Pack when testing Chinese VS Code. Enable password memory only inside the development window when testing. Keep production passwords out of fixtures and reports.

## Repository layout

```text
src/                   VS Code UI, credential core, settings, TypeScript tests
l10n/                  Runtime translation bundles
media/                 Extension icon supplied for this project
native/                Windows SSH/SCP/ASKPASS/broker implementation and Go tests
native/testserver/     Separate loopback SSH/SFTP fixture module
scripts/               Build, integration, localization, docs, and package checks
docs/                  User guides, architecture, test strategy and dated reports
.github/               Windows CI and issue/pull-request templates
package.nls*.json      Localized manifest contributions
```

`bin/`, `dist/`, `artifacts/`, `.test-runtime/`, and `.test-host/` are generated and excluded from Git. Do not commit user-data directories, password files, local credentials, or built VSIX files as source. Distribute verified packages as release assets once a release is authorized.

## Checks

| Command                                         | Purpose                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                 | Prettier check, TypeScript compile/unit tests, localization/docs checks, Go unit tests.                                     |
| `npm run test:integration`                      | Real supported Windows OpenSSH against a loopback SSH/SFTP fixture.                                                         |
| `npm run test:extension`                        | Actual compiled extension/native bridge with mocked VS Code API, UI and SecretStorage; runs English and Chinese separately. |
| `npm run test:host -- -Code <path-to-Code.exe>` | Isolated real VS Code activation and SecretStorage checks; needs installed test dependency versions.                        |
| `npm run test:race`                             | Go race detector; requires GCC on PATH.                                                                                     |
| `go vet ./...` in `native/`                     | Native static analysis.                                                                                                     |
| `npm run format`                                | Format JS/TS/JSON/Markdown/YAML and Go source.                                                                              |
| `npm run package`                               | Build and package a version-derived Windows x64 VSIX.                                                                       |
| `npm run verify:package`                        | Exact file inventory, source hashes, target and PE x64 checks.                                                              |

See [Testing](docs/testing.md) for isolation details, expected evidence, and manual acceptance. A mocked API test is not real-host UI verification.

## Translations

The extension follows VS Code's display language, using [native localization](https://github.com/microsoft/vscode-l10n).

1. Use a literal English message in `vscode.l10n.t('Message with {0}', value)`.
2. Add the same key to `l10n/bundle.l10n.zh-cn.json`, preserving all numbered placeholders.
3. For manifest contributions, add matching keys to `package.nls.json` and `package.nls.zh-cn.json`, referenced as `%key%` in `package.json`.
4. Run `npm run test:localization` and `npm run test:extension`. Check both display languages in a real development host before calling localization visually verified.

Do not translate OpenSSH parser inputs, raw authentication challenges, hostnames, usernames, fingerprints, command IDs, or protocol fields. Recognized host-trust requests may use localized labels while preserving fingerprint values and matching them to the active SSH session. Drive control flow with IDs/booleans rather than translated labels. English remains the fallback and the primary documentation language.

## Pull requests

Explain the concrete problem, resulting behavior, and relevant validation. Include sanitized evidence and the remaining gaps. For authentication changes, cover rejection, cancellation, host-key changes, fallback, and delayed saves/revocation as appropriate. Do not loosen the build allowlist to make a CI runner pass.

CI runs on Windows and builds/verifies the package. Loopback integration runs only when the runner's system SSH hash matches the compatibility contract; otherwise the job summary explicitly records it as **not run**. Real VS Code host tests and manual acceptance are not part of this workflow. A green CI badge alone would not prove end-user readiness.

## Preparing a public repository or release

- Keep the `repository`, `homepage`, and `bugs` metadata aligned with the actual GitHub repository when moving or forking the project.
- `local-tools` is the existing local publisher ID. Choose and register the intended publisher before Marketplace publication. Changing publisher/name changes extension identity and storage paths, so document migration or restore settings first.
- Keep `package.json`, `package-lock.json`, README package examples, and the changelog version aligned.
- Complete the [manual acceptance checklist](docs/testing.md#manual-acceptance) and publish a dated test report with accurate limitations.
- Build the VSIX, verify its inventory and SHA256, and review licenses/security-reporting settings.
- Do not add Marketplace, CI, download, or rating badges until the corresponding public resource exists.

Local packaging preserves relative documentation and image links with `--no-rewrite-relative-links`, so it does not need an invented repository URL. Before a Marketplace release, configure real content/image base URLs and review how the rendered listing resolves those links.

No publishing or remote Git push is performed by build/package commands.

## License

Contributions are provided under the project's [MIT license](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/LICENSE). Preserve third-party notices when changing dependencies.
