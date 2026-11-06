package main

import (
	"encoding/json"
	"strings"
)

// Use VS Code's resolved display language when its inherited NLS configuration
// is available. No authentication data or global environment changes are needed.
func nativeErrorMessage(code, nlsConfig string) string {
	language := ""
	if len(nlsConfig) <= 16384 {
		var config struct {
			ResolvedLanguage string `json:"resolvedLanguage"`
			Locale           string `json:"locale"`
			UserLocale       string `json:"userLocale"`
		}
		if json.Unmarshal([]byte(nlsConfig), &config) == nil {
			language = config.ResolvedLanguage
			if language == "" {
				language = config.Locale
			}
			if language == "" {
				language = config.UserLocale
			}
		}
	}
	language = strings.ToLower(strings.ReplaceAll(language, "_", "-"))
	chinese := language == "zh-cn" || strings.HasPrefix(language, "zh-cn-") ||
		language == "zh-hans" || strings.HasPrefix(language, "zh-hans-")
	if code == "invalid-ssh-path" {
		if chinese {
			return "SSH 密码记忆：SSH 程序路径无效。请在 VS Code 用户设置中恢复 remote.SSH.path。"
		}
		return "SSH Password Memory: The SSH program path is invalid. Restore remote.SSH.path in VS Code user settings."
	}
	if chinese {
		return "SSH 密码记忆：无法启动本地 SSH 辅助程序。请检查 VS Code 用户设置中的 remote.SSH.path。"
	}
	return "SSH Password Memory: Could not start the local SSH helper. Check remote.SSH.path in VS Code user settings."
}
