package main

import (
	"reflect"
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
func TestPipeName(t *testing.T) {
	if !strings.HasPrefix(stablePipe("C:/test"), "\\\\.\\pipe\\") {
		t.Fatal("invalid Windows pipe")
	}
}

func TestTaggedSuccess(t *testing.T) {
	line := "C:\\\\__w\\\\1\\\\s\\\\sshconnect2.c:ssh_userauth2():501 (pid=23776): Authenticated to 127.0.0.1 ([127.0.0.1]:11427) using \"password\"."
	m := taggedLog.FindStringSubmatch(line)
	if m == nil {
		t.Fatal("no match")
	}
	t.Logf("parts=%q", m)
	s := AuthState{Verified: true, Accepted: true}
	s.line(m[5])
	if !s.Success {
		t.Fatal("not success")
	}
}

func TestQuietArgs(t *testing.T) {
	a := []string{"-vT", "-oLogLevel=DEBUG3", "-o", "LogVerbose=*", "-p22", "host", "echo", "-v", "-oLogLevel=DEBUG3"}
	v := quietArgs(a)
	if !reflect.DeepEqual(v[5:], []string{"-T", "-p", "22", "host", "echo", "-v", "-oLogLevel=DEBUG3"}) {
		t.Fatal(v)
	}
	if strings.Contains(v[4], "ssh_userauth2():*,") || strings.Contains(v[4], "authmethod_get():*,") {
		t.Fatal("unsafe wide logging")
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
