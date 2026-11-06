package main

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// We only cache direct connections with strict host checking. OpenSSH remains
// authoritative for all configuration expansion and host-file verification.
func parseTarget(s string) (Target, error) {
	m := map[string]string{}
	for _, l := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(l), " ")
		if ok {
			m[k] = strings.TrimSpace(v)
		}
	}
	t := Target{Host: strings.ToLower(m["hostname"]), Port: m["port"], User: m["user"]}
	p, e := strconv.Atoi(t.Port)
	if e != nil || p < 1 || p > 65535 || t.Host == "" || t.User == "" || strings.ContainsAny(t.Host+t.User, "\r\n\x00") {
		return t, errors.New("invalid target")
	}
	if m["proxyjump"] != "" && m["proxyjump"] != "none" || m["proxycommand"] != "" && m["proxycommand"] != "none" {
		return t, errors.New("proxy authentication is not supported")
	}
	if m["stricthostkeychecking"] != "true" && m["stricthostkeychecking"] != "yes" && m["stricthostkeychecking"] != "ask" {
		return t, errors.New("strict host verification required")
	}
	return t, nil
}
func unmanagedArgs(a []string) bool {
	for _, v := range a {
		if v == "-V" || v == "-G" || v == "-Q" || v == "-E" || strings.HasPrefix(v, "-E") || v == "-O" {
			return true
		}
	}
	return len(a) == 0
}

var fingerprintRE = regexp.MustCompile("^debug1: Server host key: [A-Za-z0-9@._+-]+ (SHA256:[A-Za-z0-9+/]{43})$")
var knownRE = regexp.MustCompile("^debug1: Host '.+' is known and matches the [A-Za-z0-9@._+-]+ host key\\.$")
var successRE = regexp.MustCompile("^Authenticated to .+ using \\\"(password|keyboard-interactive|publickey|none)\\\"\\.$")

type AuthState struct {
	Fingerprint                                          string
	Verified, TrustAccepted, Success, Rejected, Accepted bool
	Method                                               string
	PasswordOffered                                      bool
	KbdRequests, KbdPrompts                              int
	KbdUnsafe, KbdPartial                                bool
}

func (s *AuthState) line(l string) {
	l = strings.TrimSuffix(l, "\r")
	if m := fingerprintRE.FindStringSubmatch(l); m != nil {
		s.Fingerprint = m[1]
		s.Verified = false
	}
	if s.Fingerprint != "" && knownRE.MatchString(l) {
		s.Verified = true
	}
	if s.TrustAccepted && s.Fingerprint != "" && strings.HasPrefix(l, "Warning: Permanently added ") {
		s.Verified = true
	}
	if strings.Contains(l, "REMOTE HOST IDENTIFICATION HAS CHANGED") || strings.Contains(l, "Host key verification failed") {
		s.Verified = false
		s.TrustAccepted = false
	}
	if strings.HasPrefix(l, "debug1: Next authentication method: ") {
		next := strings.TrimPrefix(l, "debug1: Next authentication method: ")
		if next != s.Method {
			s.KbdRequests = 0
			s.KbdPrompts = 0
		}
		s.Method = next
	}
	if s.PasswordOffered && (strings.HasPrefix(l, "debug1: Authentications that can continue:") || l == "Permission denied, please try again.") {
		s.Rejected = true
		s.PasswordOffered = false
	}
	if l == "Authenticated using \"keyboard-interactive\" with partial success." {
		s.KbdPartial = true
		s.Rejected = false
		s.PasswordOffered = false
	}
	if m := successRE.FindStringSubmatch(l); m != nil && s.Verified && s.Accepted {
		s.Success = true
		s.Method = m[1]
	}
}
func promptKind(prompt, hint string, t Target, s AuthState) string {
	if hint == "confirm" || strings.Contains(prompt, "Are you sure you want to continue connecting") {
		return "trust"
	}
	// A single canonical interactive password is eligible; other challenges stay manual.
	prefix := "(" + t.User + "@" + t.Host + ") "
	if s.Method == "keyboard-interactive" && s.Verified && s.KbdPrompts == 1 && s.KbdRequests == 1 && !s.KbdUnsafe && !s.KbdPartial && strings.HasPrefix(prompt, prefix) && strings.EqualFold(strings.TrimSpace(strings.TrimPrefix(prompt, prefix)), "Password:") {
		return "interactive-password"
	}
	if s.Method == "password" && s.Verified && prompt == t.User+"@"+t.Host+"'s password: " {
		return "password"
	}
	if s.Method == "password" && s.Verified && strings.TrimSpace(prompt) == t.User+"@"+t.Host+"'s password:" {
		return "password"
	}
	return "manual"
}

func (s *AuthState) packet(body string) {
	if body == "receive packet: type 52" {
		s.Accepted = true
	}
	if body == "receive packet: type 51" && s.PasswordOffered {
		s.Rejected = true
		s.PasswordOffered = false
		if s.Method == "keyboard-interactive" {
			s.KbdRequests = 0
			s.KbdPrompts = 0
		}
	}
}

func (s *AuthState) keyboardPrompts(n int) {
	s.KbdPrompts = n
	if n > 0 {
		s.KbdRequests++
		if n != 1 || s.KbdRequests > 1 {
			s.KbdUnsafe = true
		}
	}
}
