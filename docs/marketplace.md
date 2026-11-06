# Marketplace package and publisher migration

[README](../README.md) · [Compatibility](compatibility.md) · [Recovery](troubleshooting.md)

## Install the published extension

[Remote SSH Password Memory on the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Devlin.remote-ssh-password-memory) is published under Devlin. Version 0.1.6 was the first successful OIDC publication on 2026-11-06. The public Marketplace package SHA256 matched the verified GitHub Release artifact. Trusted Publishing and the repository’s automatic-publish variable are now configured for this repository.

The setup instructions below remain available for maintainers and forks. Marketplace-installed copies receive updates through VS Code according to the user’s automatic-update settings.

## Extension identity

The registered publisher ID supplied for this project is **Devlin**. The manifest identity is:

```text
Devlin.remote-ssh-password-memory
```

Version 0.1.5 changes the publisher from the earlier local-tools preview. VS Code treats these as different extensions. Saved passwords and extension storage do not automatically move between them.

## Migrate from the local-tools preview

Complete these steps in the local Windows VS Code window before installing the Devlin package:

1. In the old extension, run **SSH Password Memory: Disable and Restore SSH Settings**.
2. Uninstall the old **local-tools** extension.
3. Reload the VS Code window to release its command registrations.
4. Install the new Devlin VSIX, or install the Devlin listing after it has been published.
5. Reload the local window. Password memory starts automatically.
6. Enter passwords again in VS Code. Choose **Remember on This Device** when desired.

The old and new extensions use the same management command IDs, so they should not remain enabled side by side. Old saved passwords are not exported, copied, or deleted by this update. If you want to remove the old saved copies, use the old extension's **Delete Saved Password** command before uninstalling it.

From 0.1.8, setup recognizes an exact stale local-tools helper path; current releases run this automatically on local activation. It carries over original SSH settings from a matching recovery journal when available. If those files were removed, it selects a supported real OpenSSH program, records that working program for later disable/recovery. It never saves a missing legacy helper as the new restoration target.

This repairs connection settings only. Passwords remain in their original extension namespace and are not copied. If automatic path recovery cannot find the supported OpenSSH build, follow the [manual recovery guide](troubleshooting.md#restore-remote-ssh-after-removal).

## Build the upload package

```powershell
npm ci
npm run check
npm run package
npm run verify:package
```

The standard Windows x64 VSIX now works for both local installation and manual Marketplace upload. The README uses absolute HTTPS documentation/image URLs, and the normal vsce link processing stays enabled.

Package verification checks the publisher against Devlin, the complete extension identity/version, the platform, exact file inventory, source hashes, native x64 binaries, and the published README link scheme.

## Upload from the publisher account

1. Open the [Marketplace publisher management page](https://marketplace.visualstudio.com/manage) and select **Devlin**.
2. Create a **Visual Studio Code** extension and upload the verified Windows x64 VSIX.
3. Review the identity, version, description, icon, and compatibility requirements in the management page.
4. Complete the platform's submission process and inspect its validation status.

Local packaging never uploads an extension. The distribution workflow creates a GitHub preview Release after trusted main-branch CI succeeds. Marketplace publishing additionally requires the one-time setup below.

Use [Microsoft's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for account-side publishing. Later automated publishing can use GitHub Trusted Publishing, after the publisher policy and workflow have been configured.

## Validation scope

This publisher change does not expand supported platforms, OpenSSH builds, authentication modes, or the tested VS Code baseline. The [test report](testing/2026-11-06.md) distinguishes loopback/mocked-API checks from real-host UI and SecretStorage acceptance.

## One-time automatic publishing setup

In publisher Devlin’s Marketplace management page, open Trusted Publishing and create this policy:

| Field            | Value                       |
| ---------------- | --------------------------- |
| Policy name      | RemoteSSH GitHub publishing |
| Repository owner | Gerard-Devlin               |
| Repository       | RemoteSSH-password          |
| Workflow         | publish.yml                 |
| Environment      | Leave empty                 |

After the policy is created, set the GitHub repository Actions variable MARKETPLACE_PUBLISH_ENABLED to the exact value true. This is a variable, not a secret. Leave it unset until the publisher policy is ready. Rerun the latest main-branch Windows checks once to perform the first automated publish.

The publish job uses OIDC; no PAT is required. The release job can write GitHub Releases, while only the separate Marketplace job can request an OIDC token.

## Everyday development

Optionally write release notes under an Unreleased heading in CHANGELOG.md, then run:

```powershell
npm run version:patch
git add .
git commit -m "Describe the update"
git push origin main
```

The version command updates package.json, package-lock.json, both README version references, and the changelog. Use version:minor for a minor increment. Add -- --dry-run to preview changes.

A successful trusted main-branch push runs Windows checks, verifies the VSIX, and creates an immutable GitHub preview Release with the installer and SHA256SUMS.txt. When the Marketplace switch is enabled, it publishes that same canonical package to publisher Devlin. Pull requests and other branches do not distribute packages.

Existing tags and published assets are not overwritten. If a version already belongs to another commit, distribution is skipped with a reminder to increment the version. Rerunning the same commit reuses and verifies the existing release package. Existing Marketplace versions are skipped rather than replaced.

Check both Windows checks and Release and Marketplace in GitHub Actions. A skipped Marketplace job means setup is not enabled or the version was already used; it does not mean the extension was uploaded.
