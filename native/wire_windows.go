//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"path/filepath"
	"strings"
	"time"
	"unsafe"
)

func stablePipe(dir string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(dir)) + currentSID()))
	return "\\\\.\\pipe\\ssh-password-memory-" + hex.EncodeToString(sum[:16])
}
func currentSID() string {
	u, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		panic(e)
	}
	return u.User.Sid.String()
}
func secureListen(name string) (net.Listener, error) {
	return winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + currentSID() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
func secureDirectory(name string) error {
	sd, e := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + currentSID() + ")")
	if e != nil {
		return e
	}
	dacl, _, e := sd.DACL()
	if e != nil {
		return e
	}
	return windows.SetNamedSecurityInfo(name, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func peerPID(c net.Conn, server bool) (uint32, error) {
	f, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return 0, errors.New("unsupported pipe")
	}
	var pid uint32
	var e error
	if server {
		e = windows.GetNamedPipeServerProcessId(windows.Handle(f.Fd()), &pid)
	} else {
		e = windows.GetNamedPipeClientProcessId(windows.Handle(f.Fd()), &pid)
	}
	return pid, e
}
func processImage(pid uint32) string {
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if e != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	b := make([]uint16, 32768)
	n := uint32(len(b))
	if windows.QueryFullProcessImageName(h, 0, &b[0], &n) != nil {
		return ""
	}
	return windows.UTF16ToString(b[:n])
}
func parentMap() map[uint32]uint32 {
	out := map[uint32]uint32{}
	h, e := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if e != nil {
		return out
	}
	defer windows.CloseHandle(h)
	pe := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for e = windows.Process32First(h, &pe); e == nil; e = windows.Process32Next(h, &pe) {
		out[pe.ProcessID] = pe.ParentProcessID
	}
	return out
}
func samePath(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}
func dialVerified(name, exe string, timeout time.Duration) (net.Conn, error) {
	c, e := winio.DialPipe(name, &timeout)
	if e != nil {
		return nil, e
	}
	pid, e := peerPID(c, true)
	if e != nil || !samePath(processImage(pid), exe) {
		c.Close()
		return nil, errors.New("pipe server identity mismatch")
	}
	return c, nil
}
