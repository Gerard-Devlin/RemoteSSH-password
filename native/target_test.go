package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

const testFP = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestResolveTarget(t *testing.T) {
	s := "hostname SERVER.example\nuser user1\nport 2022\nstricthostkeychecking ask\n"
	v, e := parseTarget(s)
	if e != nil || v.Host != "server.example" || v.Port != "2022" {
		t.Fatal(v, e)
	}
	for _, x := range []string{s + "proxyjump jump\n", s + "proxycommand cmd\n", strings.ReplaceAll(s, "ask", "false"), strings.ReplaceAll(s, "2022", "0")} {
		if _, e := parseTarget(x); e == nil {
			t.Fatal("unsafe config accepted")
		}
	}
}
func TestAuthState(t *testing.T) {
	s := AuthState{}
	s.line("debug1: Server host key: ssh-ed25519 " + testFP)
	s.line("Authenticated to server ([127.0.0.1]:22) using \"password\".")
	if s.Success {
		t.Fatal("unverified success")
	}
	s.line("debug1: Host 'server' is known and matches the ED25519 host key.")
	s.line("debug1: Next authentication method: password")
	target := Target{Host: "server", User: "alice", Port: "22"}
	if promptKind("alice@server's password: ", "", target, s) != "password" {
		t.Fatal("password not recognized")
	}
	if promptKind("Password: ", "", target, s) != "manual" {
		t.Fatal("generic prompt cached")
	}
	s.PasswordOffered = true
	s.line("debug1: Authentications that can continue: password")
	if !s.Rejected {
		t.Fatal("rejection missing")
	}
	s.Accepted = true
	s.Accepted = true
	s.line("Authenticated to server ([127.0.0.1]:22) using \"password\".")
	if !s.Success {
		t.Fatal("success missing")
	}
}
func TestHostChange(t *testing.T) {
	s := AuthState{Verified: true, Fingerprint: testFP}
	s.line("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")
	if s.Verified {
		t.Fatal("changed key accepted")
	}
}
func TestTrust(t *testing.T) {
	s := AuthState{Fingerprint: testFP, TrustAccepted: true}
	s.line("Warning: Permanently added 'server' (ED25519) to the list of known hosts.")
	if !s.Verified {
		t.Fatal("explicit trust not tracked")
	}
}
func TestProbes(t *testing.T) {
	for _, a := range [][]string{{"-V"}, {"-G", "a"}, {"-E", "log", "a"}, {"-Q", "cipher"}, {}} {
		if !unmanagedArgs(a) {
			t.Fatal(a)
		}
	}
}
func TestEnvironmentReplacement(t *testing.T) {
	a := childEnv([]string{"ssh_askpass=old", "OTHER=x"}, map[string]string{"SSH_ASKPASS": "new"})
	if len(a) != 2 || !strings.Contains(strings.Join(a, ";"), "SSH_ASKPASS=new") {
		t.Fatal(a)
	}
}
func TestResolveNestedBridgePrograms(t *testing.T) {
	root := t.TempDir()
	realSSH := filepath.Join(root, "real", executableName("ssh"))
	realSCP := filepath.Join(root, "real", executableName("scp"))
	if err := os.MkdirAll(filepath.Dir(realSSH), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realSSH, []byte("real ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, "bridge-v2", "old")
	cur := filepath.Join(root, "bridge-v2", "current")
	for _, dir := range []string{old, cur} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, executableName("ssh")), []byte("wrapper"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	hash := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	writeConfig := func(dir, next, scp string) {
		t.Helper()
		b, _ := json.Marshal(Config{RealSSH: next, RealSCP: scp, RealSSHHash: hash, Enabled: true})
		if err := os.WriteFile(filepath.Join(dir, "bridge.json"), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig(old, realSSH, realSCP)
	writeConfig(cur, filepath.Join(old, executableName("ssh")), filepath.Join(old, executableName("scp")))
	got := resolveRealPrograms(Config{
		RealSSH:     filepath.Join(cur, executableName("ssh")),
		RealSCP:     filepath.Join(cur, executableName("scp")),
		RealSSHHash: "wrong",
		Enabled:     true,
	})
	if got.RealSSH != realSSH || got.RealSCP != realSCP || got.RealSSHHash != hash || !got.Enabled {
		t.Fatalf("nested bridge not resolved: %+v", got)
	}
	writeConfig(old, filepath.Join(cur, executableName("ssh")), filepath.Join(cur, executableName("scp")))
	loop := Config{
		RealSSH:     filepath.Join(cur, executableName("ssh")),
		RealSCP:     filepath.Join(cur, executableName("scp")),
		RealSSHHash: hash,
		Enabled:     true,
	}
	if got := resolveRealPrograms(loop); got.Enabled || got.RealSSH != defaultSSH() {
		t.Fatalf("bridge loop did not fall back safely: %+v", got)
	}
}
func TestPipeName(t *testing.T) {
	name := stablePipe("C:/test")
	if runtime.GOOS == "windows" {
		if !strings.HasPrefix(name, `\\.\pipe\`) {
			t.Fatal("invalid Windows pipe")
		}
	} else if !filepath.IsAbs(name) || len(name)+len("-window-")+48 >= 104 {
		t.Fatal("invalid Unix socket path")
	}
}

func TestTaggedSuccess(t *testing.T) {
	line := "C:\\\\__w\\\\1\\\\s\\\\sshconnect2.c:ssh_userauth2():501 (pid=23776): Authenticated to 127.0.0.1 ([127.0.0.1]:11427) using \"password\"."
	m, ok := parseTaggedLog(line)
	if !ok {
		t.Fatal("no match")
	}
	t.Logf("parts=%q", m)
	s := AuthState{Verified: true, Accepted: true}
	s.line(m.body)
	if !s.Success {
		t.Fatal("not success")
	}
}

func TestTaggedTruncatedWindowsSourceNames(t *testing.T) {
	for _, line := range []string{
		`debug1: C:\\a\\_work\\1\\s\\OSS_Microsoft_OpenSSH_Dev\\sshconn:verify_host_key():1506 (pid=23776): Server host key: ssh-ed25519 SHA256:test`,
		`debug1: C:\\a\\_work\\1\\s\\OSS_Microsoft_OpenSSH_Dev\\readpas:read_passphrase():175 (pid=23776): requested to askpass`,
		`debug3: C:\\a\\_work\\1\\s\\OSS_Microsoft_OpenSSH_Dev\\packet.:ssh_packet_read_poll2():1664 (pid=23776): receive packet: type 52`,
	} {
		if _, ok := parseTaggedLog(line); !ok {
			t.Fatalf("truncated Windows source log not parsed: %s", line)
		}
	}
	line := `debug1: C:\\__w\\1\\s\\readpass.c:read_passphrase():176 (bin=C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openssh-10.0p: requested to askpass`
	m, ok := parseTaggedLog(line)
	if !ok || m.pid != "" || m.function != "read_passphrase" || m.body != "requested to askpass" {
		t.Fatalf("truncated bin tag not parsed: %+v", m)
	}
}

func TestQuietArgs(t *testing.T) {
	a := []string{"-vT", "-oLogLevel=DEBUG3", "-o", "LogVerbose=*", "-p22", "host", "echo", "-v", "-oLogLevel=DEBUG3"}
	profile, ok := windowsOpenSSHProfileFor(
		"98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8",
	)
	if !ok {
		t.Fatal("missing system OpenSSH profile")
	}
	v := windowsQuietArgs(a, profile.LogVerbose)
	if !reflect.DeepEqual(v[5:], []string{"-T", "-p", "22", "host", "echo", "-v", "-oLogLevel=DEBUG3"}) {
		t.Fatal(v)
	}
	if strings.Contains(v[4], "authmethod_get():*,") {
		t.Fatal("unsafe wide logging")
	}
}

func TestWindowsOpenSSHProfiles(t *testing.T) {
	expected := map[string]string{
		"98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8": "system-9.5p2",
		"e41e50a22dffeae8bb13bce4cb47b6c4aa0de4cdecbd62ef79d5046adc05a8b1": "openssh-9.5p1",
		"edb93b2139ee59fbee2b8dc0ba9f929d7ecda64d47d61eb1029de1413dff3224": "openssh-9.8p2",
		"6890c128c86cc2c38aad9fcb32a82b851ff3d38c714a1f656b8e445d7cd5e1c6": "openssh-10.0p2",
	}
	for hash, id := range expected {
		profile, ok := windowsOpenSSHProfileFor(hash)
		if !ok || profile.ID != id || !strings.Contains(profile.LogVerbose, "ssh_packet_read_poll2():") {
			t.Fatalf("invalid profile for %s: %+v", hash, profile)
		}
	}
}
func TestSuccessNeedsPacket(t *testing.T) {
	s := AuthState{Verified: true, Fingerprint: testFP}
	s.line("Authenticated to server using \"password\".")
	if s.Success {
		t.Fatal("accepted uncorroborated log")
	}
}

func TestInteractivePassword(t *testing.T) {
	target := Target{Host: "server", User: "alice", Port: "22"}
	s := AuthState{Verified: true, Method: "keyboard-interactive"}
	s.keyboardPrompts(1)
	if promptKind("(alice@server) Password: ", "", target, s) != "interactive-password" {
		t.Fatal("fixed password not recognized")
	}
	for _, p := range []string{"(alice@server) Verification code: ", "(alice@server) OTP: ", "(other@server) Password: ", "(alice@server) Enter passphrase: "} {
		if promptKind(p, "", target, s) != "manual" {
			t.Fatal("non-password request eligible")
		}
	}
	s.keyboardPrompts(1)
	if promptKind("(alice@server) Password: ", "", target, s) != "manual" {
		t.Fatal("second request eligible")
	}
	s = AuthState{Verified: true, Method: "keyboard-interactive"}
	s.keyboardPrompts(2)
	if promptKind("(alice@server) Password: ", "", target, s) != "manual" {
		t.Fatal("multiple fields eligible")
	}
	s = AuthState{Verified: true, Method: "keyboard-interactive", PasswordOffered: true}
	s.keyboardPrompts(1)
	s.packet("receive packet: type 51")
	if !s.Rejected {
		t.Fatal("rejection not tracked")
	}
	s.keyboardPrompts(1)
	if promptKind("(alice@server) Password: ", "", target, s) != "interactive-password" {
		t.Fatal("single-field retry not eligible")
	}
	s.line("Authenticated using \"keyboard-interactive\" with partial success.")
	if s.Rejected || !s.KbdPartial {
		t.Fatal("partial success treated as rejection")
	}
	if promptKind("(alice@server) Password: ", "", target, s) != "manual" {
		t.Fatal("partial conversation eligible")
	}
}

func TestAppleTaggedDiagnostics(t *testing.T) {
	line := `debug1: sshconnect.c:verify_host_key():1678 (bin=/usr/bin/ssh, pid=123): Server host key: ssh-ed25519 ` + testFP
	m := taggedLog.FindStringSubmatch(line)
	if m == nil || m[2] != "verify_host_key" || m[4] != "123" {
		t.Fatal("Apple diagnostic not recognized")
	}
}
