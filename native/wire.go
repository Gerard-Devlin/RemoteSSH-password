package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
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
	Focused     bool   `json:"focused,omitempty"`
	Reply       *Reply `json:"reply,omitempty"`
}

func nonce() string {
	var b [24]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
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
