# Remote SSH Password Memory 使用指南

[English README](../README.md) · [兼容范围（英文）](compatibility.md) · [恢复说明（英文）](troubleshooting.md)

Windows x64 和 macOS（Apple 芯片 / Intel）的 VS Code 扩展，配合 Microsoft Remote-SSH 使用。首次输入固定密码后可选择记住；只有 OpenSSH 确认密码认证成功才写入 VS Code SecretStorage。

> 当前为 0.3.2 预览版，最低支持 VS Code 1.85.0（包含 1.136.1）。Windows 仍校验已支持的 OpenSSH 精确构建；Mac 使用系统 OpenSSH 9.0+。请先阅读[兼容范围](compatibility.md)和[当前测试报告](testing/2026-11-07.md)。

Mac 打开命令面板使用 **Cmd+Shift+P**。若交互式密码被拒绝，当前连接后续请求会保守地按手动验证处理；重新连接后可再次记住固定密码。

## 从旧版迁移

Publisher 现为 `Devlin`。若已安装 `local-tools` 预览版，请先在旧版运行“关闭并恢复 SSH 设置”，卸载旧扩展并重载窗口，再安装新版。旧密码不会自动迁移；新旧扩展应避免同时启用，详细步骤见[商店打包与迁移指南（英文）](marketplace.md)。

如果旧版已卸载，而启用时报错的路径仍指向 `local-tools`，0.1.8 起可在启用时修复这个遗留路径。当前版本会在本地启动时自动修复该路径；旧版密码不会迁移。

## 安装与连接

1. 在本地 Windows x64 或 macOS VS Code 安装 Microsoft Remote-SSH，再从[应用商店](https://marketplace.visualstudio.com/items?itemName=Devlin.remote-ssh-password-memory)安装本扩展，确认发布者为 **Devlin**。也可从 [GitHub Releases](https://github.com/Gerard-Devlin/RemoteSSH-password/releases) 下载 `remote-ssh-password-memory-0.3.2-win32-x64.vsix`，通过“从 VSIX 安装”手动安装。
   Mac 请按本地 VS Code 架构选择 `remote-ssh-password-memory-0.3.2-darwin-arm64.vsix`（Apple 芯片）或 `remote-ssh-password-memory-0.3.2-darwin-x64.vsix`（Intel）。
2. 安装后会自动接入，无需再运行“启用”命令或确认设置弹窗。
3. 继续用 Remote-SSH 选择服务器，先核对首次信任的服务器指纹。
4. 在 VS Code 隐藏密码框输入固定密码，选择“记住到本机”或“仅本次使用”。
5. 成功认证后，可用“管理已保存密码”查看目标和指纹，不会显示密码。

安装后自动启用；如果你主动关闭，会保持关闭，直到你重新启用。商店安装的版本会按 VS Code 的自动更新设置接收新版。密码失效时，每个连接至多自动提供一次旧密码，再请求新输入。普通 SSH 密码，以及经过识别的单一交互式 Password 请求，都可以选择记住。验证码、密钥口令和额外的多步骤验证不保存。

## 语言与命令

界面跟随 VS Code 的显示语言：默认英文，简体中文为 `zh-cn`。通过 **Configure Display Language / 配置显示语言** 切换并重启 VS Code。OpenSSH 原始提示与指纹保持原文。

| 中文命令                          | English command                                       |
| --------------------------------- | ----------------------------------------------------- |
| SSH 密码记忆: 启用                | SSH Password Memory: Enable                           |
| SSH 密码记忆: 管理已保存密码      | SSH Password Memory: Manage Saved Passwords           |
| SSH 密码记忆: 删除已保存密码      | SSH Password Memory: Delete Saved Password            |
| SSH 密码记忆: 关闭并恢复 SSH 设置 | SSH Password Memory: Disable and Restore SSH Settings |
| SSH 密码记忆: 查看诊断            | SSH Password Memory: Show Diagnostics                 |

## 关闭和恢复

需要删除密码时先“删除已保存密码”，再“关闭并恢复 SSH 设置”，最后禁用或卸载。关闭功能会保留密码；不要依赖卸载来删除凭据。

启用只接管用户级 `remote.SSH.path` 和 `remote.SSH.useLocalServer`。关闭时仅恢复仍由插件设置的值。直接卸载时，保留的稳定桥接可在不读取凭据的情况下运行普通 OpenSSH；若全局存储被清理，须按[恢复说明](troubleshooting.md#restore-remote-ssh-after-removal)还原 SSH 路径，避免残留路径阻止连接。

## 开发与安全

源码、贡献流程和测试说明以英文为主，见[贡献指南](../CONTRIBUTING.md)。密码只应在实际 VS Code 密码框输入，不应放入聊天、命令行、设置文件或 Issue。[安全模型](../SECURITY.md)解释了同账户恶意程序、内存以及回退行为的边界。

## 自动更新到商店

配置一次 Devlin 的 Trusted Publishing 后，可在本地运行 `npm run version:patch`，提交并推送到 main。CI 通过后会生成 GitHub Release；启用仓库变量 MARKETPLACE_PUBLISH_ENABLED 后，会使用 OIDC 自动发布到应用商店。无需每次手动上传，也无需提供 PAT。字段和首次启用步骤见[发布指南](marketplace.md#one-time-automatic-publishing-setup)。
