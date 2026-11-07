package main

import "testing"

func TestWindowIdentityAndFocus(t *testing.T) {
	one := []windowInfo{{Pipe: "one", Parent: 9, Instance: "pid:1"}}
	if got := chooseWindow(one, "pid:1", map[uint32]int{9: 1}); got != "one" {
		t.Fatalf("single instance window not selected: %q", got)
	}
	many := []windowInfo{
		{Pipe: "other-instance", Parent: 9, Instance: "pid:2", Focused: 100},
		{Pipe: "ancestor", Parent: 9, Instance: "pid:1"},
		{Pipe: "focused", Parent: 99, Instance: "pid:1", Focused: 200},
	}
	if got := chooseWindow(many, "pid:1", map[uint32]int{9: 1}); got != "focused" {
		t.Fatalf("focused same-instance window not selected: %q", got)
	}
	many[2].Focused = 0
	if got := chooseWindow(many, "pid:1", map[uint32]int{9: 1}); got != "ancestor" {
		t.Fatalf("ancestry fallback not selected: %q", got)
	}
}

func TestWindowInstanceUsesVSCodeIdentity(t *testing.T) {
	t.Setenv("VSCODE_PID", "123")
	t.Setenv("VSCODE_IPC_HOOK", "")
	if got := windowInstance(); got != "pid:123" {
		t.Fatalf("unexpected instance identity: %q", got)
	}
}

func TestStaleRouteSelectionStaysWithinVSCodeInstance(t *testing.T) {
	windows := []windowInfo{
		{Pipe: "other", Parent: 9, Instance: "pid:2", Focused: 300},
		{Pipe: "current", Parent: 99, Instance: "pid:1", Focused: 200},
	}
	if got := chooseWindowForInstance(
		windows,
		"pid:1",
		map[uint32]int{9: 1},
	); got != "current" {
		t.Fatalf("stale route left the current instance: %q", got)
	}
	if got := chooseWindowForInstance(windows, "pid:3", nil); got != "" {
		t.Fatalf("unknown instance borrowed another broker: %q", got)
	}
	if got := chooseWindowForInstance(windows, "", nil); got != "" {
		t.Fatalf("missing instance identity did not fail closed: %q", got)
	}
}
