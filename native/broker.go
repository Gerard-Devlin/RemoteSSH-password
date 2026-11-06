package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Each window owns a broker. Wrapper processes select a window by process
// ancestry, or by the explicit non-secret route inherited by Remote-SSH.
// A separate leader pipe arbitrates simultaneous password UI across windows.
type uiBridge struct {
	mu      sync.Mutex
	out     sync.Mutex
	pending map[string]chan Message
	done    chan struct{}
}

func newUI() *uiBridge {
	u := &uiBridge{pending: map[string]chan Message{}, done: make(chan struct{})}
	go func() {
		defer close(u.done)
		s := bufio.NewScanner(os.Stdin)
		s.Buffer(make([]byte, 4096), maxFrame)
		for s.Scan() {
			var m Message
			if json.Unmarshal(s.Bytes(), &m) != nil {
				continue
			}
			u.mu.Lock()
			ch := u.pending[m.ID]
			u.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}()
	return u
}
func (u *uiBridge) emit(m Message) error {
	u.out.Lock()
	defer u.out.Unlock()
	return json.NewEncoder(os.Stdout).Encode(m)
}
func (u *uiBridge) request(m Message) (Message, error) {
	m.ID = nonce()
	ch := make(chan Message, 1)
	u.mu.Lock()
	u.pending[m.ID] = ch
	u.mu.Unlock()
	defer func() { u.mu.Lock(); delete(u.pending, m.ID); u.mu.Unlock() }()
	if e := u.emit(m); e != nil {
		return Message{}, e
	}
	select {
	case v := <-ch:
		return v, nil
	case <-u.done:
		return Message{}, net.ErrClosed
	case <-time.After(4 * time.Minute):
		return Message{}, net.ErrClosed
	}
}

type windowInfo struct {
	Pipe   string `json:"pipe"`
	PID    uint32 `json:"pid"`
	Parent uint32 `json:"parent"`
}

func runBroker(dir string) int {
	u := newUI()
	p := stablePipe(dir) + "-window-" + nonce()
	l, e := secureListen(p)
	if e != nil {
		return 1
	}
	defer l.Close()
	os.MkdirAll(filepath.Join(dir, "windows"), 0700)
	info := windowInfo{Pipe: p, PID: uint32(os.Getpid()), Parent: uint32(os.Getppid())}
	b, _ := json.Marshal(info)
	f := filepath.Join(dir, "windows", nonce()+".json")
	if os.WriteFile(f, b, 0600) != nil {
		return 1
	}
	defer os.Remove(f)
	u.emit(Message{Type: "ready", Prompt: p})
	go func() {
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			go serveWindow(c, dir, u)
		}
	}()
	go coordinatorLoop(dir, u.done)
	<-u.done
	return 0
}
func serveWindow(c net.Conn, dir string, u *uiBridge) {
	defer c.Close()
	pid, e := peerPID(c, false)
	if e != nil || !samePath(processImage(pid), filepath.Join(dir, executableName("ssh"))) {
		return
	}
	ch := channel(c)
	session := nonce()
	var once sync.Once
	endSession := func() { once.Do(func() { u.emit(Message{Type: "end", Session: session}) }) }
	defer endSession()
	inbox := make(chan Message)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer close(inbox)
		for {
			m, e := ch.read()
			if e != nil {
				endSession()
				return
			}
			select {
			case inbox <- m:
			case <-done:
				return
			}
		}
	}()
	first := true
	var target Target
	for m := range inbox {
		if first {
			if m.Type != "open" {
				return
			}
			first = false
			target = m.Target
		} else if m.Type != "ask" && m.Type != "success" && m.Type != "rejected" {
			return
		}
		id := m.ID
		m.ID = ""
		m.Session = session
		m.Target = target
		var r Message
		if m.Type == "ask" && (m.Kind == "password" || m.Kind == "interactive-password") {
			r, e = coordinate(dir, m, u)
		} else {
			r, e = u.request(m)
		}
		if e != nil {
			r = Message{Reply: &Reply{Canceled: true}}
		}
		r.ID = id
		if ch.send(r) != nil {
			return
		}
	}
}
func selectWindow(dir string) (net.Conn, error) {
	expected := filepath.Join(dir, executableName("broker"))
	if p := os.Getenv("SSHPM_WINDOW_PIPE"); p != "" {
		return dialVerified(p, expected, 300*time.Millisecond)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "windows", "*.json"))
	parents := parentMap()
	ancestry := map[uint32]int{}
	n := uint32(os.Getpid())
	for i := 0; i < 32 && n != 0; i++ {
		ancestry[n] = i
		n = parents[n]
	}
	best := 1000
	chosen := ""
	for _, f := range files {
		b, e := os.ReadFile(f)
		if e != nil {
			continue
		}
		var w windowInfo
		if json.Unmarshal(b, &w) != nil || !samePath(processImage(w.PID), expected) {
			continue
		}
		if d, ok := ancestry[w.Parent]; ok && d < best {
			best = d
			chosen = w.Pipe
		}
	}
	if chosen == "" {
		return nil, net.ErrClosed
	}
	return dialVerified(chosen, expected, 300*time.Millisecond)
}

// No secret is cached here: only in-flight answers, for at most the lifetime of
// the concurrent requests. The leader is always a verified broker executable.
type flight struct {
	done   chan struct{}
	result Message
}

func coordinatorLoop(dir string, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		default:
		}
		l, e := secureListen(stablePipe(dir) + "-coordinator")
		if e != nil {
			select {
			case <-done:
				return
			case <-time.After(time.Second):
				continue
			}
		}
		var mu sync.Mutex
		active := map[string]*flight{}
		go func() { <-done; l.Close() }()
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			go func() {
				defer c.Close()
				pid, e := peerPID(c, false)
				if e != nil || !samePath(processImage(pid), filepath.Join(dir, executableName("broker"))) {
					return
				}
				ch := channel(c)
				ch.SetReadDeadline(time.Now().Add(5 * time.Second))
				m, e := ch.read()
				if e != nil || m.Type != "coordinate" || m.Prompt == "" {
					return
				}
				ch.SetReadDeadline(time.Now().Add(4 * time.Minute))
				key := m.Prompt
				mu.Lock()
				f, exists := active[key]
				if !exists {
					f = &flight{done: make(chan struct{})}
					active[key] = f
				}
				mu.Unlock()
				if !exists {
					ch.send(Message{Type: "leader"})
					v, e := ch.read()
					if e != nil || v.Type != "answer" {
						v = Message{Reply: &Reply{Canceled: true}}
					}
					mu.Lock()
					f.result = v
					delete(active, key)
					close(f.done)
					mu.Unlock()
				} else {
					select {
					case <-f.done:
						ch.send(f.result)
					case <-done:
						return
					case <-time.After(4 * time.Minute):
						return
					}
				}
			}()
		}
	}
}

func coordinate(dir string, m Message, u *uiBridge) (Message, error) {
	c, e := dialVerified(stablePipe(dir)+"-coordinator", filepath.Join(dir, executableName("broker")), time.Second)
	if e != nil {
		return u.request(m)
	}
	defer c.Close()
	ch := channel(c)
	ch.SetReadDeadline(time.Now().Add(4 * time.Minute))
	data, _ := json.Marshal([]any{m.Target, m.Fingerprint, m.Failed, m.Kind})
	key := fmt.Sprintf("%x", sha256.Sum256(data))
	if ch.send(Message{Type: "coordinate", Prompt: key}) != nil {
		return Message{}, net.ErrClosed
	}
	r, e := ch.read()
	if e != nil {
		return Message{}, e
	}
	if r.Type == "leader" {
		r, e = u.request(m)
		if e != nil {
			r = Message{Reply: &Reply{Canceled: true}}
		}
		r.Type = "answer"
		ch.send(r)
		return r, e
	}
	// The receiving extension still has to register the shared candidate locally
	// before it can react to this connection's independent authentication result.
	m.Type = "shared"
	m.Reply = r.Reply
	return u.request(m)
}
