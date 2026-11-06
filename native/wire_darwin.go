//go:build darwin

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

func stablePipe(dir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	return filepath.Join("/tmp", fmt.Sprintf("sshpm-%d-%s", os.Getuid(), hex.EncodeToString(sum[:12])), "ipc")
}
func secureDirectory(name string) error {
	info, err := os.Lstat(name)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || stat.Uid != uint32(os.Getuid()) {
		return errors.New("unsafe directory")
	}
	return os.Chmod(name, 0700)
}

type lockedListener struct {
	net.Listener
	lock *os.File
	once sync.Once
}

func (l *lockedListener) Close() error {
	err := l.Listener.Close()
	l.once.Do(func() { _ = unix.Flock(int(l.lock.Fd()), unix.LOCK_UN); _ = l.lock.Close() })
	return err
}
func secureListen(name string) (net.Listener, error) {
	dir := filepath.Dir(name)
	if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	if err := secureDirectory(dir); err != nil {
		return nil, err
	}
	fd, err := unix.Open(name+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), name+".lock")
	if err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		lock.Close()
		return nil, err
	}
	// Only the lock owner may remove a socket left by a crashed process.
	if err = os.Remove(name); err != nil && !os.IsNotExist(err) {
		lock.Close()
		return nil, err
	}
	l, err := net.Listen("unix", name)
	if err != nil {
		lock.Close()
		return nil, err
	}
	if err = os.Chmod(name, 0600); err != nil {
		l.Close()
		lock.Close()
		return nil, err
	}
	return &lockedListener{Listener: l, lock: lock}, nil
}
func peerPID(c net.Conn, _ bool) (uint32, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, errors.New("unsupported socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var peerErr error
	err = raw.Control(func(fd uintptr) {
		cred, e := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if e != nil {
			peerErr = e
			return
		}
		if cred.Uid != uint32(os.Getuid()) {
			peerErr = errors.New("socket user mismatch")
			return
		}
		pid, peerErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	if err != nil {
		return 0, err
	}
	return uint32(pid), peerErr
}
func parentMap() map[uint32]uint32 {
	out := map[uint32]uint32{}
	entries, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return out
	}
	for _, p := range entries {
		out[uint32(p.Proc.P_pid)] = uint32(p.Eproc.Ppid)
	}
	return out
}
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	x, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false
	}
	y, err := filepath.EvalSymlinks(b)
	if err != nil {
		return false
	}
	return x == y
}
func dialVerified(name, exe string, timeout time.Duration) (net.Conn, error) {
	c, err := net.DialTimeout("unix", name, timeout)
	if err != nil {
		return nil, err
	}
	pid, err := peerPID(c, true)
	if err != nil || !samePath(processImage(pid), exe) {
		c.Close()
		return nil, errors.New("socket server identity mismatch")
	}
	return c, nil
}
