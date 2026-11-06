//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// LogVerbose source locations are verified for this exact Windows binary.
// Unknown or updated binaries must fall back, never guess authentication success.
const testedSSHHash = "98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8"

type Config struct {
	RealSSHHash string `json:"realSSHHash"`
	RealSSH     string `json:"realSSH"`
	RealSCP     string `json:"realSCP"`
	Enabled     bool   `json:"enabled"`
}

func loadConfig(dir string) (Config, error) {
	var c Config
	b, e := os.ReadFile(filepath.Join(dir, "bridge.json"))
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(b, &c)
	return c, e
}
func exitCode(e error) int {
	if e == nil {
		return 0
	}
	if x, ok := e.(*exec.ExitError); ok {
		return x.ExitCode()
	}
	return 255
}
func passthrough(exe string, args []string) int {
	c := exec.Command(exe, args...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return exitCode(c.Run())
}
func main() {
	exe, e := os.Executable()
	if e != nil {
		os.Exit(255)
	}
	dir := filepath.Dir(exe)
	mode := strings.ToLower(filepath.Base(exe))
	args := os.Args[1:]
	if len(args) == 2 && args[0] == "--secure-directory" && mode == "broker.exe" {
		if secureDirectory(args[1]) != nil {
			os.Exit(1)
		}
		return
	}
	if mode == "askpass.exe" {
		os.Exit(runAskpass(dir, args))
	}
	if mode == "broker.exe" {
		os.Exit(runBroker(dir))
	}
	c, e := loadConfig(dir)
	if e != nil {
		c.RealSSH = filepath.Join(os.Getenv("WINDIR"), "System32", "OpenSSH", "ssh.exe")
		c.RealSCP = filepath.Join(filepath.Dir(c.RealSSH), "scp.exe")
	}
	if !filepath.IsAbs(c.RealSSH) || samePath(c.RealSSH, exe) || samePath(filepath.Dir(c.RealSSH), dir) {
		safeError("invalid-ssh-path")
		os.Exit(255)
	}
	if mode == "scp.exe" {
		if !filepath.IsAbs(c.RealSCP) || samePath(filepath.Dir(c.RealSCP), dir) {
			os.Exit(255)
		}
		if c.Enabled && len(args) > 0 {
			found := false
			for _, a := range args {
				if a == "-S" || strings.HasPrefix(a, "-S") {
					found = true
				}
			}
			if !found {
				args = append([]string{"-S", filepath.Join(dir, "ssh.exe")}, args...)
			}
		}
		os.Exit(passthrough(c.RealSCP, args))
	}
	os.Exit(runSSH(dir, c, args))
}
func hidden() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func fileHash(file string) string {
	b, e := os.ReadFile(file)
	if e != nil {
		return ""
	}
	return fmt.Sprintf("%x", sha256.Sum256(b))
}
