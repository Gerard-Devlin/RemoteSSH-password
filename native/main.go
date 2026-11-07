package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
func defaultConfig() Config {
	ssh := defaultSSH()
	return Config{
		RealSSH: ssh,
		RealSCP: filepath.Join(filepath.Dir(ssh), executableName("scp")),
	}
}
func helperManifest(exe string) (Config, bool) {
	if !filepath.IsAbs(exe) {
		return Config{}, false
	}
	info, e := os.Stat(exe)
	if e != nil || info.IsDir() {
		return Config{}, false
	}
	if _, e = os.Stat(filepath.Join(filepath.Dir(exe), "bridge.json")); e != nil {
		return Config{}, false
	}
	c, e := loadConfig(filepath.Dir(exe))
	return c, e == nil
}
func bridgeManifest(exe string) (Config, bool) {
	if filepath.Base(exe) != executableName("ssh") {
		return Config{}, false
	}
	return helperManifest(exe)
}

// Older generations can accidentally point at another bridge generation.
// Resolve that chain without executing nested wrappers.
func resolveRealPrograms(c Config) Config {
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		nested, managed := bridgeManifest(c.RealSSH)
		if !managed {
			if i > 0 && !filepath.IsAbs(c.RealSCP) {
				return defaultConfig()
			}
			if _, managedSCP := helperManifest(c.RealSCP); managedSCP {
				return defaultConfig()
			}
			return c
		}
		key := filepath.Clean(filepath.Dir(c.RealSSH))
		if seen[key] || !filepath.IsAbs(nested.RealSSH) {
			return defaultConfig()
		}
		seen[key] = true
		c.RealSSH = nested.RealSSH
		c.RealSCP = nested.RealSCP
		c.RealSSHHash = nested.RealSSHHash
		c.Enabled = c.Enabled && nested.Enabled
	}
	return defaultConfig()
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
	if len(args) == 2 && args[0] == "--secure-directory" && mode == executableName("broker") {
		if secureDirectory(args[1]) != nil {
			os.Exit(1)
		}
		return
	}
	if mode == executableName("askpass") {
		os.Exit(runAskpass(dir, args))
	}
	if mode == executableName("broker") {
		os.Exit(runBroker(dir))
	}
	c, e := loadConfig(dir)
	if e != nil {
		c = defaultConfig()
	}
	c = resolveRealPrograms(c)
	if !filepath.IsAbs(c.RealSSH) || samePath(c.RealSSH, exe) || samePath(filepath.Dir(c.RealSSH), dir) {
		safeError("invalid-ssh-path")
		os.Exit(255)
	}
	if mode == executableName("scp") {
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
				args = append([]string{"-S", filepath.Join(dir, executableName("ssh"))}, args...)
			}
		}
		os.Exit(passthrough(c.RealSCP, args))
	}
	os.Exit(runSSH(dir, c, args))
}
func fileHash(file string) string {
	b, e := os.ReadFile(file)
	if e != nil {
		return ""
	}
	return fmt.Sprintf("%x", sha256.Sum256(b))
}
