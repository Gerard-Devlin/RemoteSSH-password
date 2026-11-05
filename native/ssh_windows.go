//go:build windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"
)

type authSession struct {
	mu           sync.Mutex
	state        AuthState
	rpc          *RPC
	target       Target
	completed    bool
	canceled     bool
	askCount     int
	logAsks      int
	offers       int
	child        *os.Process
	pid          uint32
	ready        chan struct{}
	packetPrefix string
}

var taggedLog = regexp.MustCompile("^(?:debug[123]: )?.*(sshconnect2?\\.c|readpass\\.c|packet\\.c):([a-zA-Z_0-9]+)\\(\\):(\\d+) \\(pid=(\\d+)\\): (.*)$")

func (s *authSession) consumeLog(r io.Reader) {
	reader := bufio.NewReaderSize(r, 65536)
	fragmented := false
	for {
		line, err := reader.ReadSlice('\n')
		if err == bufio.ErrBufferFull || fragmented {
			// Never parse a continuation as a diagnostic or discard remote stderr.
			os.Stderr.Write(line)
			fragmented = err == bufio.ErrBufferFull
		} else if len(line) > 0 {
			s.consumeLine(line)
			s.mu.Lock()
			completed := s.completed
			prefix := s.packetPrefix
			s.mu.Unlock()
			if completed && prefix != "" {
				filter := &packetFilter{dst: os.Stderr, prefix: []byte(prefix)}
				io.Copy(filter, reader)
				filter.flush()
				return
			}
		}
		if err != nil && err != bufio.ErrBufferFull {
			return
		}
	}
}
func (s *authSession) consumeLine(line []byte) {
	l := strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r")
	m := taggedLog.FindStringSubmatch(l)
	if m == nil || m[4] != strconv.Itoa(int(s.pid)) {
		os.Stderr.Write(line)
		return
	}
	body := m[5]
	if strings.HasPrefix(l, "debug1: ") {
		body = "debug1: " + body
	}
	s.mu.Lock()
	if m[2] == "read_passphrase" && strings.Contains(body, "requested to askpass") {
		s.logAsks++
	}
	if !s.completed {
		if m[2] == "ssh_packet_read_poll2" {
			s.packetPrefix = strings.TrimSuffix(l, m[5]) + "receive packet: type "
			s.state.packet(m[5])
		} else {
			s.state.line(body)
		}
	}
	success := s.state.Success
	s.mu.Unlock()
	if m[2] != "ssh_packet_read_poll2" {
		fmt.Fprintln(os.Stderr, body)
	}
	if success {
		s.notifySuccess()
	}
}

func (s *authSession) notifySuccess() {
	s.mu.Lock()
	ok := s.state.Success && !s.completed
	method := s.state.Method
	if ok {
		s.completed = true
	}
	s.mu.Unlock()
	if ok {
		s.rpc.request(Message{Type: "success", Method: method}, 5*time.Second)
	}
}
func (s *authSession) serveAsk(c net.Conn, dir string) {
	defer c.Close()
	select {
	case <-s.ready:
	case <-time.After(10 * time.Second):
		return
	}
	pid, e := peerPID(c, false)
	if e != nil || !samePath(processImage(pid), filepath.Join(dir, "askpass.exe")) {
		return
	}
	parents := parentMap()
	p := parents[pid]
	allowed := false
	for i := 0; i < 4 && p != 0; i++ {
		if p == s.pid {
			allowed = true
			break
		}
		if !strings.EqualFold(filepath.Base(processImage(p)), "cmd.exe") {
			break
		}
		p = parents[p]
	}
	if !allowed {
		return
	}
	ch := channel(c)
	ch.SetReadDeadline(time.Now().Add(5 * time.Second))
	m, e := ch.read()
	if e != nil || m.Type != "prompt" || len(m.Prompt) > 8192 {
		return
	}
	ch.SetReadDeadline(time.Time{})
	// The read_passphrase marker precedes launching ASKPASS. Wait for that
	// exact per-process marker, never rely on a fixed sleep to order diagnostics.
	s.mu.Lock()
	s.askCount++
	sequence := s.askCount
	wasCanceled := s.canceled
	s.mu.Unlock()
	if wasCanceled {
		if s.child != nil {
			s.child.Kill()
		}
		ch.send(Message{Reply: &Reply{Canceled: true}})
		return
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		ready := s.logAsks >= sequence
		s.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			// Fail closed if the authentication diagnostic never arrives.
			// A nonzero ASKPASS exit alone can send an empty password.
			if s.child != nil {
				s.child.Kill()
			}
			s.mu.Lock()
			s.canceled = true
			s.mu.Unlock()
			ch.send(Message{Reply: &Reply{Canceled: true}})
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.mu.Lock()
	st := s.state
	kind := promptKind(m.Prompt, m.Kind, s.target, st)
	failed := st.Rejected || kind == "password" && s.offers > 0
	if kind == "password" {
		s.offers++
	}
	s.state.Rejected = false
	s.mu.Unlock()
	answer, e := s.rpc.request(Message{Type: "ask", Target: s.target, Fingerprint: st.Fingerprint, Verified: st.Verified, Kind: kind, Prompt: m.Prompt, Failed: failed}, 4*time.Minute)
	if e != nil || answer.Reply == nil {
		answer.Reply = &Reply{Canceled: true}
	}
	if answer.Reply.Canceled {
		// A failed ASKPASS can otherwise be interpreted as an empty password.
		// Kill the active SSH child before returning cancellation.
		if s.child != nil {
			s.child.Kill()
		}
		s.mu.Lock()
		s.canceled = true
		s.mu.Unlock()
	}
	if !answer.Reply.Canceled {
		s.mu.Lock()
		if kind == "trust" && answer.Reply.Value == "yes" {
			s.state.TrustAccepted = true
		}
		if kind == "password" {
			s.state.PasswordOffered = true
		}
		s.mu.Unlock()
	}
	ch.send(Message{Type: "answer", ID: m.ID, Reply: answer.Reply})
}
func runSSH(dir string, cfg Config, args []string) int {
	if !cfg.Enabled || unmanagedArgs(args) || cfg.RealSSHHash != testedSSHHash || fileHash(cfg.RealSSH) != testedSSHHash {
		return passthrough(cfg.RealSSH, args)
	}
	conn, e := selectWindow(dir)
	if e != nil {
		return passthrough(cfg.RealSSH, args)
	}
	rpc := newRPC(channel(conn))
	defer rpc.close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	g := exec.CommandContext(ctx, cfg.RealSSH, append([]string{"-G"}, args...)...)
	g.SysProcAttr = hidden()
	var out bytes.Buffer
	g.Stdout = &out
	g.Stderr = io.Discard
	if g.Run() != nil || out.Len() > 1024*1024 {
		return passthrough(cfg.RealSSH, args)
	}
	target, e := parseTarget(out.String())
	if e != nil {
		return passthrough(cfg.RealSSH, args)
	}
	if _, e = rpc.request(Message{Type: "open", Target: target}, 3*time.Second); e != nil {
		return passthrough(cfg.RealSSH, args)
	}
	p := stablePipe(dir) + "-ask-" + nonce()
	l, e := secureListen(p)
	if e != nil {
		return passthrough(cfg.RealSSH, args)
	}
	defer l.Close()
	s := &authSession{rpc: rpc, target: target, ready: make(chan struct{})}
	a := quietArgs(args)
	cmd := exec.Command(cfg.RealSSH, a...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	stderr, writeEnd, e := os.Pipe()
	if e != nil {
		return 255
	}
	defer stderr.Close()
	defer writeEnd.Close()
	cmd.Stderr = writeEnd
	cmd.SysProcAttr = hidden()
	cmd.Env = childEnv(os.Environ(), map[string]string{"SSH_ASKPASS": filepath.Join(dir, "askpass.exe"), "SSH_ASKPASS_REQUIRE": "force", "SSHPM_SESSION_PIPE": p})
	job, e := newJob()
	if e != nil {
		return passthrough(cfg.RealSSH, args)
	}
	defer windows.CloseHandle(job)
	if cmd.Start() != nil {
		writeEnd.Close()
		return 255
	}
	writeEnd.Close()
	s.child = cmd.Process
	s.pid = uint32(cmd.Process.Pid)
	if bindJob(job, s.pid) != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return 255
	}
	close(s.ready)
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			go s.serveAsk(c, dir)
		}
	}()
	finished := make(chan struct{})
	go func() { defer close(finished); s.consumeLog(stderr) }()
	err := cmd.Wait()
	<-finished
	s.notifySuccess()
	s.mu.Lock()
	rejected := s.state.Rejected
	s.mu.Unlock()
	if rejected {
		rpc.request(Message{Type: "rejected"}, 2*time.Second)
	}
	return exitCode(err)
}
func childEnv(env []string, values map[string]string) []string {
	out := []string{}
	for _, v := range env {
		k, _, _ := strings.Cut(v, "=")
		found := false
		for key := range values {
			if strings.EqualFold(k, key) {
				found = true
			}
		}
		if !found {
			out = append(out, v)
		}
	}
	for k, v := range values {
		out = append(out, k+"="+v)
	}
	return out
}
func runAskpass(dir string, args []string) int {
	if len(args) != 1 {
		return 1
	}
	p := os.Getenv("SSHPM_SESSION_PIPE")
	if p == "" {
		return 1
	}
	c, e := dialVerified(p, filepath.Join(dir, "ssh.exe"), 3*time.Second)
	if e != nil {
		return 1
	}
	defer c.Close()
	ch := channel(c)
	ch.SetReadDeadline(time.Now().Add(4 * time.Minute))
	if ch.send(Message{Type: "prompt", Prompt: args[0], Kind: os.Getenv("SSH_ASKPASS_PROMPT")}) != nil {
		return 1
	}
	m, e := ch.read()
	if e != nil || m.Reply == nil || m.Reply.Canceled || len(m.Reply.Value) > 8192 || strings.ContainsAny(m.Reply.Value, "\x00\r\n") {
		return 1
	}
	fmt.Fprintln(os.Stdout, m.Reply.Value)
	return 0
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

// Preserve transport options, but own diagnostic verbosity before starting SSH.
// QUIET suppresses server-provided authentication banners; only selected local
// log callsites are enabled. No files are used for the log stream.
func quietArgs(args []string) []string {
	out := []string{"-q", "-o", "LogLevel=QUIET", "-o", "LogVerbose=*:verify_host_key():1549*,*:check_host_key():1131*,*:check_host_key():1133*,*:check_host_key():1300*,*:ssh_userauth2():501*,*:authmethod_get():2375*,*:authmethod_get():2365*,*:userauth_passwd():*,*:ssh_packet_read_poll2():1664*,*:read_passphrase():*,*:warn_changed_key():*,*:ssh_connect_direct():*"}
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
