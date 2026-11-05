package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestPacketFilter(t *testing.T) {
	prefix := "debug3: local:1664 (pid=42): receive packet: type "
	input := "before" + prefix + "94\r\n" + strings.Repeat("z", 200000) + prefix + "1\n" + "尾部-without-newline"
	want := "before" + strings.Repeat("z", 200000) + "尾部-without-newline"
	for _, size := range []int{1, 8, 2048, 65536} {
		var out bytes.Buffer
		f := packetFilter{dst: &out, prefix: []byte(prefix)}
		for i := 0; i < len(input); i += size {
			end := i + size
			if end > len(input) {
				end = len(input)
			}
			f.Write([]byte(input[i:end]))
		}
		f.flush()
		if out.String() != want {
			t.Fatalf("fragment size %d lost bytes", size)
		}
	}
}
func TestPacketFilterPreservesLookalikes(t *testing.T) {
	prefix := "local: type "
	for _, input := range []string{"unrelated", "part local: ty", prefix + "not a packet", prefix + "1234\n", prefix + "12"} {
		var out bytes.Buffer
		f := packetFilter{dst: &out, prefix: []byte(prefix)}
		f.Write([]byte(input))
		f.flush()
		if out.String() != input {
			t.Fatal("removed remote output")
		}
	}
}
