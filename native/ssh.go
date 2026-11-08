package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
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

var taggedLog = regexp.MustCompile("^(?:debug[123]: )?.*((?:sshconnect2?\\.c|sshconn2?|sshconnect\\.|sshconnect2|readpass\\.c|readpas|packet\\.c|packet\\.)):([a-zA-Z_0-9]+)\\(\\):(\\d+) \\((?:bin=[^\\r\\n]+, )?pid=(\\d+)\\): (.*)$")
var taggedLogTruncatedBin = regexp.MustCompile("^(?:debug[123]: )?.*((?:sshconnect2?\\.c|sshconn2?|sshconnect\\.|sshconnect2|readpass\\.c|readpas|packet\\.c|packet\\.)):([a-zA-Z_0-9]+)\\(\\):(\\d+) \\(bin=.*?: (.*)$")

type taggedLogParts struct {
	function string
	body     string
	pid      string
}

func visibleTaggedBody(function, body string) bool {
	if function == "ssh_packet_read_poll2" {
		return false
	}
	if function == "authmethod_get" {
		return strings.HasPrefix(body, "Next authentication method: ")
	}
	if function == "input_userauth_info_req" {
		return strings.HasPrefix(body, "num_prompts ")
	}
	if function == "input_userauth_failure" {
		return strings.HasPrefix(body, "Authenticated using \"") &&
			strings.HasSuffix(body, " with partial success.")
	}
	return true
}

func parseTaggedLog(line string) (taggedLogParts, bool) {
	if match := taggedLog.FindStringSubmatch(line); match != nil {
		return taggedLogParts{function: match[2], pid: match[4], body: match[5]}, true
	}
	if match := taggedLogTruncatedBin.FindStringSubmatch(line); match != nil {
		return taggedLogParts{function: match[2], body: match[4]}, true
	}
	return taggedLogParts{}, false
}

func askpassDiagnostic(stage string) {
	if os.Getenv("SSHPM_DIAGNOSTIC_ASKPASS") != "" {
		fmt.Fprintln(os.Stderr, "SSHPasswordMemory askpass diagnostic: "+stage)
	}
}

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
	m, ok := parseTaggedLog(l)
	if !ok || (m.pid != "" && m.pid != strconv.Itoa(int(s.pid))) {
		os.Stderr.Write(line)
		return
	}
	body := m.body
	if strings.HasPrefix(l, "debug1: ") {
		body = "debug1: " + body
	}
	s.mu.Lock()
	updatePlatformState(&s.state, m.function, m.body)
	if m.function == "read_passphrase" && strings.Contains(body, "requested to askpass") {
		s.logAsks++
	}
	if !s.completed {
		if m.function == "ssh_packet_read_poll2" {
			s.packetPrefix = strings.TrimSuffix(l, m.body) + "receive packet: type "
			s.state.packet(m.body)
		} else {
			if m.function == "input_userauth_info_req" {
				if strings.HasPrefix(body, "num_prompts ") {
					if n, e := strconv.Atoi(strings.TrimPrefix(body, "num_prompts ")); e == nil {
						s.state.keyboardPrompts(n)
					}
				}
			} else {
				s.state.line(body)
			}
		}
	}
	success := s.state.Success
	s.mu.Unlock()
	if visibleTaggedBody(m.function, body) {
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
	if e != nil {
		askpassDiagnostic("peer-pid")
		return
	}
	if !samePath(processImage(pid), filepath.Join(dir, executableName("askpass"))) {
		askpassDiagnostic("peer-image")
		return
	}
	if !allowedAskpass(pid, s.pid) {
		askpassDiagnostic("peer-parent")
		return
	}
	ch := channel(c)
	ch.SetReadDeadline(time.Now().Add(5 * time.Second))
	m, e := ch.read()
	if e != nil || m.Type != "prompt" || len(m.Prompt) > 8192 {
		askpassDiagnostic("prompt-frame")
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
		askpassDiagnostic("canceled-before-answer")
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
			askpassDiagnostic("log-marker-timeout")
			s.mu.Lock()
			s.canceled = true
			s.mu.Unlock()
			ch.send(Message{Reply: &Reply{Canceled: true}})
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.mu.Lock()
	preparePrompt(&s.state, m.Prompt, s.target)
	st := s.state
	kind := promptKind(m.Prompt, m.Kind, s.target, st)
	failed := st.Rejected || (kind == "password" || kind == "interactive-password") && s.offers > 0
	if kind == "password" || kind == "interactive-password" {
		s.offers++
	}
	s.state.Rejected = false
	if kind == "manual" && st.Method == "keyboard-interactive" {
		s.state.PasswordOffered = false
	}
	s.mu.Unlock()
	answer, e := s.rpc.request(Message{Type: "ask", Target: s.target, Fingerprint: st.Fingerprint, Verified: st.Verified, Kind: kind, Prompt: m.Prompt, Failed: failed}, 4*time.Minute)
	if e != nil || answer.Reply == nil {
		askpassDiagnostic("broker-reply")
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
		if kind == "password" || kind == "interactive-password" {
			s.state.PasswordOffered = true
		}
		s.mu.Unlock()
	}
	ch.send(Message{Type: "answer", ID: m.ID, Reply: answer.Reply})
}
func runSSH(dir string, cfg Config, args []string) int {
	if !cfg.Enabled || unmanagedArgs(args) || !supportedSSH(cfg) {
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
	a := quietArgs(args, cfg.LogVerbose)
	cmd := exec.Command(cfg.RealSSH, a...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	stderr, writeEnd, cleanupLog, e := createLogPipe(dir)
	if e != nil {
		return 255
	}
	defer cleanupLog()
	defer stderr.Close()
	defer writeEnd.Close()
	configureLog(cmd, writeEnd)
	cmd.SysProcAttr = hidden()
	cmd.Env = childEnv(os.Environ(), map[string]string{"SSH_ASKPASS": filepath.Join(dir, executableName("askpass")), "SSH_ASKPASS_REQUIRE": "force", "SSHPM_SESSION_PIPE": p})
	cleanup, e := startSSH(cmd)
	if e != nil {
		writeEnd.Close()
		return 255
	}
	defer cleanup()
	s.child = cmd.Process
	s.pid = uint32(cmd.Process.Pid)
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
	writeEnd.Close()
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
	c, e := dialVerified(p, filepath.Join(dir, executableName("ssh")), 3*time.Second)
	if e != nil {
		askpassDiagnostic("client-connect")
		return 1
	}
	defer c.Close()
	ch := channel(c)
	ch.SetReadDeadline(time.Now().Add(4 * time.Minute))
	if ch.send(Message{Type: "prompt", Prompt: args[0], Kind: os.Getenv("SSH_ASKPASS_PROMPT")}) != nil {
		askpassDiagnostic("client-prompt-write")
		return 1
	}
	m, e := ch.read()
	if e != nil || m.Reply == nil || m.Reply.Canceled || len(m.Reply.Value) > 8192 || strings.ContainsAny(m.Reply.Value, "\x00\r\n") {
		askpassDiagnostic("client-answer")
		return 1
	}
	fmt.Fprintln(os.Stdout, m.Reply.Value)
	return 0
}
