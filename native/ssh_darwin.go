//go:build darwin

package main

import (
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func executableName(name string) string { return name }
func defaultSSH() string                { return "/usr/bin/ssh" }
func hidden() *syscall.SysProcAttr      { return nil }
func supportedSSH(c Config) bool {
	return len(c.RealSSHHash) == 64 && fileHash(c.RealSSH) == c.RealSSHHash
}

// OpenSSH's diagnostic stream is separate from server banners and remote stderr.
// Function names are stable across Apple builds; source line numbers are not.
func configureLog(cmd *exec.Cmd, writer *os.File) {
	cmd.Stderr = os.Stderr
	cmd.Args = append([]string{cmd.Path, "-E", writer.Name()}, cmd.Args[1:]...)
}
func quietArgs(args []string) []string {
	out := windowsQuietArgs(args)
	out[4] = "LogVerbose=*:verify_host_key():*,*:check_host_key():*,*:ssh_userauth2():*,*:userauth_passwd():*,*:input_userauth_info_req():*,*:ssh_packet_read_poll2():*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*"
	return out
}
func startSSH(cmd *exec.Cmd) (func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }, nil
}
func allowedAskpass(pid, sshPID uint32) bool { return parentMap()[pid] == sshPID }

// These local callsites contain no server-provided authentication lists.
// A packet-51 keyboard retry may be a second factor: keep later prompts manual.
func updatePlatformState(st *AuthState, function, body string) {
	if function == "input_userauth_info_req" {
		st.Method = "keyboard-interactive"
	}
	if function == "ssh_packet_read_poll2" && body == "receive packet: type 51" && st.Method == "keyboard-interactive" && st.PasswordOffered {
		st.KbdUnsafe = true
	}
}
func preparePrompt(st *AuthState, prompt string, target Target) {
	if prompt == target.User+"@"+target.Host+"'s password: " || prompt == target.User+"@"+target.Host+"'s password:" {
		st.Method = "password"
	}
}

// ssh closes inherited descriptors before opening -E, so use a private FIFO.
// It streams diagnostics in memory and never creates a regular log file.
func createLogPipe(dir string) (*os.File, *os.File, func(), error) {
	name := filepath.Join(filepath.Dir(stablePipe(dir)), "log-"+nonce())
	cleanup := func() { _ = os.Remove(name) }
	if err := unix.Mkfifo(name, 0600); err != nil {
		return nil, nil, cleanup, err
	}
	reader, err := os.OpenFile(name, os.O_RDONLY|unix.O_NONBLOCK, 0600)
	if err != nil {
		cleanup()
		return nil, nil, cleanup, err
	}
	writer, err := os.OpenFile(name, os.O_WRONLY|unix.O_NONBLOCK, 0600)
	if err != nil {
		reader.Close()
		cleanup()
		return nil, nil, cleanup, err
	}
	if err := unix.SetNonblock(int(reader.Fd()), false); err != nil {
		reader.Close()
		writer.Close()
		cleanup()
		return nil, nil, cleanup, err
	}
	return reader, writer, cleanup, nil
}
