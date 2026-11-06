package main

import (
	"strings"
	"testing"
)

func TestNativeErrorUsesDisplayLanguage(t *testing.T) {
	for _, item := range []struct {
		config  string
		chinese bool
	}{
		{`{"resolvedLanguage":"zh-cn","userLocale":"en"}`, true},
		{`{"resolvedLanguage":"en","userLocale":"zh-cn"}`, false},
		{`{"locale":"zh-CN"}`, true},
		{`{"userLocale":"zh-Hans"}`, true},
		{`{"resolvedLanguage":"fr","locale":"zh-cn"}`, false},
		{`{"resolvedLanguage":"zh-tw"}`, false},
		{"invalid JSON", false},
		{"", false},
		{strings.Repeat("x", 16385), false},
	} {
		got := nativeErrorMessage("invalid-ssh-path", item.config)
		if strings.Contains(got, "SSH 密码记忆") != item.chinese || !strings.Contains(got, "remote.SSH.path") {
			t.Fatalf("wrong display language for %q", item.config[:min(len(item.config), 80)])
		}
	}
}

func TestNativeErrorNeverEchoesUnknownInput(t *testing.T) {
	synthetic := "synthetic-private-error-content"
	for _, config := range []string{`{"resolvedLanguage":"en"}`, `{"resolvedLanguage":"zh-cn"}`} {
		got := nativeErrorMessage(synthetic, config)
		if strings.Contains(got, synthetic) || !strings.Contains(got, "remote.SSH.path") {
			t.Fatal("native error must use static localized text")
		}
	}
}
