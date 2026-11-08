package main

import (
	_ "embed"
	"encoding/json"
)

type windowsOpenSSHProfile struct {
	ID             string `json:"id"`
	DisplayVersion string `json:"displayVersion"`
	VersionMarker  string `json:"versionMarker"`
	SHA256         string `json:"sha256"`
	LogVerbose     string `json:"logVerbose"`
}

//go:embed windows-openssh.json
var windowsOpenSSHProfileData []byte

var windowsOpenSSHProfilesByHash = loadWindowsOpenSSHProfiles()

func loadWindowsOpenSSHProfiles() map[string]windowsOpenSSHProfile {
	var document struct {
		Profiles []windowsOpenSSHProfile `json:"profiles"`
	}
	if err := json.Unmarshal(windowsOpenSSHProfileData, &document); err != nil {
		panic("invalid embedded Windows OpenSSH profiles: " + err.Error())
	}
	profiles := make(map[string]windowsOpenSSHProfile, len(document.Profiles))
	for _, profile := range document.Profiles {
		if profile.ID == "" || profile.DisplayVersion == "" ||
			profile.VersionMarker == "" || len(profile.SHA256) != 64 ||
			profile.LogVerbose == "" {
			panic("invalid embedded Windows OpenSSH profile")
		}
		if _, exists := profiles[profile.SHA256]; exists {
			panic("duplicate embedded Windows OpenSSH profile hash")
		}
		profiles[profile.SHA256] = profile
	}
	if len(profiles) == 0 {
		panic("no embedded Windows OpenSSH profiles")
	}
	return profiles
}

func windowsOpenSSHProfileFor(hash string) (windowsOpenSSHProfile, bool) {
	profile, ok := windowsOpenSSHProfilesByHash[hash]
	return profile, ok
}
