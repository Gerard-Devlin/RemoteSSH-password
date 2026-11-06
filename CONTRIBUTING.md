# Contributing

Thanks for helping improve Remote SSH Password Memory. Read the [compatibility contract](docs/compatibility.md) and [security model](SECURITY.md) before changing authentication or local IPC behavior.

## Development setup

Use Windows x64 or macOS (Apple Silicon / Intel), Node.js 22+, npm, and Go 1.24+. The recorded local environment uses Node.js 24.13.1 and Go 1.26.1. Put Go on PATH. A GCC toolchain such as MinGW is required for race detection only; Windows builds use `CGO_ENABLED=0`. macOS builds require Xcode Command Line Tools and `CGO_ENABLED=1` for libproc.

```powershell
npm ci
npm run check
npm run build
```

Run **Run Extension (English)** or **Run Extension (Simplified Chinese)** from the VS Code Run and Debug view. These launch configurations use separate development user-data directories. Install the matching Remote-SSH dependency into that isolated profile first, plus the Simplified Chinese Language Pack when testing Chinese VS Code. Activation now configures password memory automatically, so always launch the extension only inside those isolated development profiles. Keep production passwords out of fixtures and reports.

## Repository layout

```text
src/                   VS Code UI, credential core, settings, TypeScript tests
l10n/                  Runtime translation bundles
media/                 Extension icon supplied for this project
native/                Cross-platform SSH/SCP/ASKPASS/broker implementation and Go tests
native/testserver/     Separate loopback SSH/SFTP fixture module
scripts/               Build, integration, localization, docs, and package checks
docs/                  User guides, architecture, test strategy and dated reports
.github/               Platform CI and issue/pull-request templates
package.nls*.json      Localized manifest contributions
```

`bin/`, `dist/`, `artifacts/`, `.test-runtime/`, and `.test-host/` are generated and excluded from Git. Do not commit user-data directories, password files, local credentials, or built VSIX files as source. Distribute verified packages as release assets once a release is authorized.

## Checks

| Command                                         | Purpose                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                 | Prettier check, TypeScript compile/unit tests, localization/docs checks, Go unit tests.                                     |
| `npm run test:integration`                      | Real supported local OpenSSH against a loopback SSH/SFTP fixture.                                                           |
| `npm run test:extension`                        | Actual compiled extension/native bridge with mocked VS Code API, UI and SecretStorage; runs English and Chinese separately. |
| `npm run test:host -- -Code <path-to-Code.exe>` | Isolated real VS Code activation and SecretStorage checks; needs installed test dependency versions.                        |
| `npm run test:race`                             | Go race detector; requires GCC on PATH.                                                                                     |
| `go vet ./...` in `native/`                     | Native static analysis.                                                                                                     |
| `npm run format`                                | Format JS/TS/JSON/Markdown/YAML and Go source.                                                                              |
| `npm run package`                               | Build and package a VSIX for the current platform (`-- --target darwin-x64` selects another target).                        |
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

CI runs on Windows x64 and both macOS architectures, building/verifying one package per target. Loopback integration runs only when the runner's system SSH meets the platform compatibility contract; otherwise the job summary explicitly records it as **not run**. Real VS Code host tests and manual acceptance are not part of this workflow. A green CI badge alone would not prove end-user readiness.

## Preparing a public repository or release

- Keep the `repository`, `homepage`, and `bugs` metadata aligned with the actual GitHub repository when moving or forking the project.
- `Devlin` is the registered publisher ID used by the manifest. The earlier `local-tools` preview has a different identity and storage namespace; follow the [migration guide](docs/marketplace.md) before switching.
- Keep `package.json`, `package-lock.json`, README package examples, and the changelog version aligned.
- Complete the [manual acceptance checklist](docs/testing.md#manual-acceptance) and publish a dated test report with accurate limitations.
- Build the VSIX, verify its inventory and SHA256, and review licenses/security-reporting settings.
- Do not add Marketplace, CI, download, or rating badges until the corresponding public resource exists.

README links and images use the public repository’s absolute HTTPS URLs. Normal vsce link processing is enabled, so the verified platform packages can also be uploaded manually to Marketplace. Keep the [publisher and upload guide](docs/marketplace.md) aligned with any future identity changes.

No publishing or remote Git push is performed by build/package commands.

## License

Contributions are provided under the project's [MIT license](https://github.com/Gerard-Devlin/RemoteSSH-password/blob/main/LICENSE). Preserve third-party notices when changing dependencies.
