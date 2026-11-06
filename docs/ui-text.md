# UI text and localization

[Contributing](../CONTRIBUTING.md) · [Testing](testing.md)

## Writing rules

- Give each dialog one purpose. Use a short title, readable detail, and an action named after its effect.
- Explain what happened and the next useful action. Keep file paths, setting names, and compatibility details in dialog detail or diagnostics.
- Use the same product terms in both languages. Password deletion means removing the local saved copy, not resetting the server password.
- Do not promise that every password will be saved. Saving requires an explicit choice and successful SSH password authentication.
- Keep passwords out of titles, descriptions, messages, and logs. Connection labels and timestamps contain metadata only.
- Preserve original host fingerprints and authentication challenges. Recognized host-trust requests use localized fields; unfamiliar requests retain the original request under a localized label.
- Use VS Code's own localized keyboard hints and Cancel/OK controls. Do not append another set of Enter/Escape instructions.
- Format sign-in dates for the display language. Keep stored timestamps in their original machine-readable format.
- Use English as the source/fallback language and Simplified Chinese for zh-cn. Native helper errors use the inherited resolved VS Code display language, with English fallback.

## Terms

| Concept             | English                      | Simplified Chinese |
| ------------------- | ---------------------------- | ------------------ |
| Feature             | Password memory              | 密码记忆           |
| Save option         | Remember on This Device      | 记住到本机         |
| Temporary option    | Use Once                     | 仅本次使用         |
| Manage command      | Manage Saved Passwords       | 管理已保存密码     |
| Delete command      | Delete Saved Password        | 删除已保存密码     |
| Delete action       | Delete Password              | 删除密码           |
| Trust action        | Trust and Connect            | 信任并继续连接     |
| Background service  | Local authentication service | 本地认证服务       |
| SSH wrapper         | Local SSH helper             | 本地 SSH 辅助程序  |
| Diagnostics command | Show Diagnostics             | 查看诊断           |

## Reviewed surfaces in 0.1.4

| Surface             | Presentation and intent                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Enable              | Short question plus separate connection, setting, password, trust, and retained-helper details. Cancel leaves settings intact. |
| Already enabled     | State confirmation without repeating consent or changing settings.                                                             |
| Password input      | Connection in the title, a localized placeholder, and a short explanation of the next step.                                    |
| Rejected password   | Ask the user to try again; do not imply that the server password must be reset.                                                |
| Manual challenge    | Explain that the response is not saved; preserve the authentication request in a labeled placeholder.                          |
| Input validation    | Distinguish missing input, forbidden line breaks/null characters, and excessive byte length.                                   |
| Persistence menu    | Clear remember/use-once choices and their consequences.                                                                        |
| Host trust          | Server, key type, exact fingerprint, and an explicit action. Unrecognized requests use a neutral Continue Connection action.   |
| Saved passwords     | A short list title, a selection hint, and a readable last-sign-in time.                                                        |
| Delete              | Explicit confirmation of local-only deletion; cancellation keeps the saved value.                                              |
| Disable             | Confirm that the feature is off and saved passwords are kept. Setting restoration is recorded in diagnostics.                  |
| Errors              | Separate title and action guidance, with a Show Diagnostics button; do not display raw exception contents.                     |
| Diagnostics         | One labeled state or value per line. Use the same service/helper terms as other screens.                                       |
| Native path failure | Static English/Chinese text with the setting to recover; never echo arbitrary error data.                                      |

## Maintenance

Runtime text lives in src/extension.ts and l10n/bundle.l10n.zh-cn.json. Manifest contributions use package.nls.json and package.nls.zh-cn.json. Native helper error text is in native/messages.go.

Run npm run test:localization to check key and placeholder parity. Run npm run test:extension for each language's actual extension-entry flow using mocked VS Code API/UI/SecretStorage with real OpenSSH. The suite covers consent cancellation, unsupported SSH, storage errors, password retry, saving choices, trust, management, deletion cancellation, disable, diagnostics, and the native error path.

These checks verify content and behavior, not the actual visual rendering of every native VS Code control. Complete the real-host manual checks before calling the UI visually verified.
