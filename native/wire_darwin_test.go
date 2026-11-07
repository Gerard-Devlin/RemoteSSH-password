//go:build darwin

package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDarwinProcessIdentity(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if image := processImage(uint32(os.Getpid())); !samePath(image, exe) {
		t.Fatalf("kernel image %q differs from %q", image, exe)
	}
	if parentMap()[uint32(os.Getpid())] != uint32(os.Getppid()) {
		t.Fatal("process ancestry unavailable")
	}
}

func TestDarwinSocketIdentityAndLock(t *testing.T) {
	name := stablePipe(t.TempDir()) + "-test"
	l, err := secureListen(name)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := secureListen(name); err == nil {
		other.Close()
		t.Fatal("duplicate listener accepted")
	}
	info, err := os.Stat(filepath.Dir(name))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("unsafe socket directory")
	}
	done := make(chan error, 1)
	go func() {
		c, err := l.Accept()
		if err == nil {
			defer c.Close()
			_, err = peerPID(c, false)
			if err == nil {
				_, err = c.Read(make([]byte, 1))
			}
		}
		done <- err
	}()
	exe, _ := os.Executable()
	c, err := dialVerified(name, exe, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte{0})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	c.Close()
	go func() {
		c, err := l.Accept()
		if err == nil {
			c.Close()
		}
	}()
	if c, err := dialVerified(name, "/usr/bin/false", time.Second); err == nil {
		c.Close()
		t.Fatal("wrong executable accepted")
	}
	l.Close()
	l, err = secureListen(name)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
}

func TestDarwinDiagnosticsIsolation(t *testing.T) {
	for _, arg := range quietArgs([]string{"host"}) {
		if strings.Contains(arg, "authmethod_get") || strings.Contains(arg, "input_userauth_failure") {
			t.Fatal("server-provided method list logging enabled")
		}
	}
	st := AuthState{Method: "keyboard-interactive", Verified: true, PasswordOffered: true}
	updatePlatformState(&st, "ssh_packet_read_poll2", "receive packet: type 51")
	st.packet("receive packet: type 51")
	st.keyboardPrompts(1)
	if promptKind("(alice@host) Password: ", "", Target{Host: "host", User: "alice", Port: "22"}, st) != "manual" {
		t.Fatal("continuation incorrectly eligible")
	}
}

func TestDarwinDiagnosticFIFO(t *testing.T) {
	dir := t.TempDir()
	l, err := secureListen(stablePipe(dir) + "-test")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	r, w, cleanup, err := createLogPipe(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	defer cleanup()
	info, err := os.Lstat(w.Name())
	if err != nil || info.Mode()&os.ModeNamedPipe == 0 || info.Mode().Perm() != 0600 {
		t.Fatal("diagnostics are not a private FIFO")
	}
	done := make(chan string, 1)
	go func() { b, _ := io.ReadAll(r); done <- string(b) }()
	if _, err := w.WriteString("local diagnostics\n"); err != nil {
		t.Fatal(err)
	}
	w.Close()
	select {
	case value := <-done:
		if value != "local diagnostics\n" {
			t.Fatal(value)
		}
	case <-time.After(time.Second):
		t.Fatal("FIFO did not reach EOF")
	}
	name := w.Name()
	cleanup()
	if _, err := os.Lstat(name); !os.IsNotExist(err) {
		t.Fatal("FIFO was not removed")
	}
}
