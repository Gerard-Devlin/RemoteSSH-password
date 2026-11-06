//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

func hidden() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func newJob() (windows.Handle, error) {
	j, e := windows.CreateJobObject(nil, nil)
	if e != nil {
		return 0, e
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, e = windows.SetInformationJobObject(j, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if e != nil {
		windows.CloseHandle(j)
	}
	return j, e
}
func bindJob(j windows.Handle, pid uint32) error {
	h, e := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if e != nil {
		return e
	}
	defer windows.CloseHandle(h)
	return windows.AssignProcessToJobObject(j, h)
}

func executableName(name string) string { return name + ".exe" }
func defaultSSH() string                { return filepath.Join(os.Getenv("WINDIR"), "System32", "OpenSSH", "ssh.exe") }
func supportedSSH(c Config) bool {
	return c.RealSSHHash == testedSSHHash && fileHash(c.RealSSH) == testedSSHHash
}
func configureLog(cmd *exec.Cmd, writer *os.File) { cmd.Stderr = writer }
func startSSH(cmd *exec.Cmd) (func(), error) {
	j, e := newJob()
	if e != nil {
		return nil, e
	}
	if e = cmd.Start(); e != nil {
		windows.CloseHandle(j)
		return nil, e
	}
	if e = bindJob(j, uint32(cmd.Process.Pid)); e != nil {
		cmd.Process.Kill()
		cmd.Wait()
		windows.CloseHandle(j)
		return nil, e
	}
	return func() { windows.CloseHandle(j) }, nil
}
func allowedAskpass(pid, sshPID uint32) bool {
	parents := parentMap()
	p := parents[pid]
	for i := 0; i < 4 && p != 0; i++ {
		if p == sshPID {
			return true
		}
		if !strings.EqualFold(filepath.Base(processImage(p)), "cmd.exe") {
			break
		}
		p = parents[p]
	}
	return false
}
func quietArgs(args []string) []string { return windowsQuietArgs(args) }

func updatePlatformState(st *AuthState, function, body string)  {}
func preparePrompt(st *AuthState, prompt string, target Target) {}

func createLogPipe(dir string) (*os.File, *os.File, func(), error) {
	r, w, err := os.Pipe()
	return r, w, func() {}, err
}
