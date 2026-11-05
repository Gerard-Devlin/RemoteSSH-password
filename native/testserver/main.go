package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	DelayPasswordMS int    `json:"delayPasswordMS"`
	Password        string `json:"password"`
	Port            string `json:"port"`
	Banner          string `json:"banner"`
}

var output sync.Mutex

func emit(v any) { output.Lock(); defer output.Unlock(); json.NewEncoder(os.Stdout).Encode(v) }
func main() {
	scan := bufio.NewScanner(os.Stdin)
	scan.Scan()
	var cfg Config
	if json.Unmarshal(scan.Bytes(), &cfg) != nil {
		os.Exit(1)
	}
	var mu sync.Mutex
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	key, _ := ssh.NewSignerFromKey(private)
	config := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
		mu.Lock()
		pass := cfg.Password
		delay := cfg.DelayPasswordMS
		mu.Unlock()
		ok := string(p) == pass
		emit(map[string]any{"type": "attempt", "user": c.User(), "accepted": ok})
		if delay > 0 {
			time.Sleep(time.Duration(delay) * time.Millisecond)
		}
		if !ok {
			return nil, fmt.Errorf("rejected")
		}
		return nil, nil
	}, BannerCallback: func(c ssh.ConnMetadata) string { return cfg.Banner }}
	config.AddHostKey(key)
	addr := "127.0.0.1:0"
	if cfg.Port != "" {
		addr = "127.0.0.1:" + cfg.Port
	}
	l, e := net.Listen("tcp", addr)
	if e != nil {
		panic(e)
	}
	defer l.Close()
	emit(map[string]string{"type": "ready", "address": l.Addr().String(), "key": strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key.PublicKey()))), "fingerprint": ssh.FingerprintSHA256(key.PublicKey())})
	go func() {
		for scan.Scan() {
			var next Config
			if json.Unmarshal(scan.Bytes(), &next) == nil {
				mu.Lock()
				cfg.Password = next.Password
				cfg.DelayPasswordMS = next.DelayPasswordMS
				mu.Unlock()
				emit(map[string]string{"type": "updated"})
			}
		}
		l.Close()
		os.Exit(0)
	}()
	for {
		c, e := l.Accept()
		if e != nil {
			return
		}
		go func() {
			defer c.Close()
			conn, channels, requests, e := ssh.NewServerConn(c, config)
			if e != nil {
				return
			}
			defer conn.Close()
			go ssh.DiscardRequests(requests)
			for nc := range channels {
				switch nc.ChannelType() {
				case "session":
					ch, req, e := nc.Accept()
					if e != nil {
						continue
					}
					go session(ch, req)
				case "direct-tcpip":
					var dest struct {
						Host       string
						Port       uint32
						Origin     string
						OriginPort uint32
					}
					if ssh.Unmarshal(nc.ExtraData(), &dest) != nil || dest.Host != "127.0.0.1" {
						nc.Reject(ssh.Prohibited, "loopback only")
						continue
					}
					peer, e := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", dest.Port))
					if e != nil {
						nc.Reject(ssh.ConnectionFailed, "unavailable")
						continue
					}
					ch, req, e := nc.Accept()
					if e != nil {
						peer.Close()
						continue
					}
					go ssh.DiscardRequests(req)
					go func() { defer peer.Close(); defer ch.Close(); go io.Copy(ch, peer); io.Copy(peer, ch) }()
				default:
					nc.Reject(ssh.UnknownChannelType, "unsupported")
				}
			}
		}()
	}
}
func session(ch ssh.Channel, requests <-chan *ssh.Request) {
	defer ch.Close()
	for r := range requests {
		switch r.Type {
		case "pty-req", "env", "window-change":
			r.Reply(true, nil)
		case "subsystem":
			var sub struct{ Name string }
			ssh.Unmarshal(r.Payload, &sub)
			if sub.Name != "sftp" {
				r.Reply(false, nil)
				continue
			}
			r.Reply(true, nil)
			emit(map[string]string{"type": "subsystem", "name": sub.Name})
			dir := filepath.Join(os.TempDir(), "sshpm-sftp-fixture")
			os.MkdirAll(dir, 0700)
			server, e := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(dir))
			if e == nil {
				e = server.Serve()
				emit(map[string]string{"type": "sftp-ended", "error": fmt.Sprint(e)})
				ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			}
			return
		case "exec":
			r.Reply(true, nil)
			var cmd struct{ Command string }
			ssh.Unmarshal(r.Payload, &cmd)
			if cmd.Command == "stderr-long" {
				io.WriteString(ch.Stderr(), strings.Repeat("z", 200000)+"\n尾部-without-newline")
			} else if cmd.Command == "echo-stdin" {
				io.Copy(ch, ch)
			} else if cmd.Command == "exit-7" {
				ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{7}))
				return
			} else {
				io.WriteString(ch, "fixture-ok\n")
			}
			ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		case "shell":
			r.Reply(true, nil)
			io.Copy(ch, ch)
			ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
			return
		default:
			r.Reply(false, nil)
		}
	}
}
