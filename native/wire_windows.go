//go:build windows

package main

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const maxFrame = 64 * 1024

type Target struct {
	Host string `json:"host"`
	Port string `json:"port"`
	User string `json:"user"`
}
type Reply struct {
	Value    string `json:"value,omitempty"`
	Remember bool   `json:"remember,omitempty"`
	Source   string `json:"source,omitempty"`
	Ticket   string `json:"ticket,omitempty"`
	Revision string `json:"revision,omitempty"`
	Canceled bool   `json:"canceled,omitempty"`
}
type Message struct {
	Type        string `json:"type"`
	ID          string `json:"id,omitempty"`
	Session     string `json:"session,omitempty"`
	Target      Target `json:"target,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Verified    bool   `json:"verified,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Prompt      string `json:"prompt,omitempty"`
	Failed      bool   `json:"failed,omitempty"`
	Source      string `json:"source,omitempty"`
	Method      string `json:"method,omitempty"`
	Reply       *Reply `json:"reply,omitempty"`
}

func nonce() string {
	var b [24]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
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

type Channel struct {
	net.Conn
	scan *bufio.Scanner
	mu   sync.Mutex
}

func channel(c net.Conn) *Channel {
	s := bufio.NewScanner(c)
	s.Buffer(make([]byte, 4096), maxFrame)
	return &Channel{Conn: c, scan: s}
}
func (c *Channel) send(m Message) error {
	b, e := json.Marshal(m)
	if e != nil || len(b) >= maxFrame-1 {
		return errors.New("invalid frame")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, e = c.Write(append(b, '\n'))
	return e
}
func (c *Channel) read() (Message, error) {
	var m Message
	if !c.scan.Scan() {
		if e := c.scan.Err(); e != nil {
			return m, e
		}
		return m, errors.New("pipe closed")
	}
	e := json.Unmarshal(c.scan.Bytes(), &m)
	return m, e
}

type RPC struct {
	c       *Channel
	mu      sync.Mutex
	waiting map[string]chan Message
	done    chan struct{}
}

func newRPC(c *Channel) *RPC {
	r := &RPC{c: c, waiting: map[string]chan Message{}, done: make(chan struct{})}
	go func() {
		defer close(r.done)
		for {
			m, e := c.read()
			if e != nil {
				return
			}
			r.mu.Lock()
			ch := r.waiting[m.ID]
			r.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}()
	return r
}
func (r *RPC) request(m Message, timeout time.Duration) (Message, error) {
	m.ID = nonce()
	ch := make(chan Message, 1)
	r.mu.Lock()
	r.waiting[m.ID] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.waiting, m.ID); r.mu.Unlock() }()
	if e := r.c.send(m); e != nil {
		return Message{}, e
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case v := <-ch:
		return v, nil
	case <-r.done:
		return Message{}, errors.New("broker unavailable")
	case <-timer.C:
		return Message{}, errors.New("authentication request timed out")
	}
}
func (r *RPC) close() { r.c.Close() }
func safeError(code string) {
	fmt.Fprintln(os.Stderr, nativeErrorMessage(code, os.Getenv("VSCODE_NLS_CONFIG")))
}
