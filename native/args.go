package main

import "strings"

// Preserve transport options, but own diagnostic verbosity before starting SSH.
// QUIET suppresses server-provided authentication banners; only selected local
// log callsites are enabled. No files are used for the log stream.
func windowsQuietArgs(args []string, logVerbose string) []string {
	out := []string{"-q", "-o", "LogLevel=QUIET", "-o", "LogVerbose=" + logVerbose}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" || !strings.HasPrefix(a, "-") || a == "-" {
			out = append(out, args[i:]...)
			break
		}
		flags := "-"
		for j := 1; j < len(a); j++ {
			c := a[j]
			if c == 'v' || c == 'q' {
				continue
			}
			if strings.ContainsRune("BbcDEeFIiJLlmOopQRSWw", rune(c)) {
				v := a[j+1:]
				if v == "" && i+1 < len(args) {
					i++
					v = args[i]
				}
				lower := strings.ToLower(strings.TrimSpace(v))
				if c != 'o' || !strings.HasPrefix(lower, "loglevel") && !strings.HasPrefix(lower, "logverbose") {
					out = append(out, flags+string(c), v)
				}
				flags = "-"
				break
			}
			flags += string(c)
		}
		if flags != "-" {
			out = append(out, flags)
		}
	}
	return out
}
