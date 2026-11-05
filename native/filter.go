package main

import (
	"bytes"
	"io"
)

// Once authenticated, no remote output is interpreted as an auth event.
// Remove only the exact local numeric packet-log prefix observed before auth.
// OpenSSH can emit this between fragments of a remote stderr write, so a
// line-oriented filter would otherwise corrupt long or unterminated output.
type packetFilter struct {
	dst     io.Writer
	prefix  []byte
	pending []byte
}

func (f *packetFilter) Write(p []byte) (int, error) {
	n := len(p)
	f.pending = append(f.pending, p...)
	for len(f.pending) > 0 {
		i := bytes.Index(f.pending, f.prefix)
		if i < 0 {
			keep := 0
			for k := 1; k < len(f.prefix) && k <= len(f.pending); k++ {
				if bytes.Equal(f.pending[len(f.pending)-k:], f.prefix[:k]) {
					keep = k
				}
			}
			emit := len(f.pending) - keep
			if emit > 0 {
				if _, err := f.dst.Write(f.pending[:emit]); err != nil {
					return 0, err
				}
				f.pending = f.pending[emit:]
			}
			return n, nil
		}
		if i > 0 {
			if _, err := f.dst.Write(f.pending[:i]); err != nil {
				return 0, err
			}
			f.pending = f.pending[i:]
		}
		tail := f.pending[len(f.prefix):]
		j := 0
		for j < len(tail) && j < 3 && tail[j] >= '0' && tail[j] <= '9' {
			j++
		}
		end := j
		if end < len(tail) && tail[end] == '\r' {
			end++
		}
		if end == len(tail) && j <= 3 {
			return n, nil
		}
		if j > 0 && end < len(tail) && tail[end] == '\n' {
			f.pending = f.pending[len(f.prefix)+end+1:]
			continue
		}
		// A similar-looking remote string is ordinary stderr, not a numeric event.
		if _, err := f.dst.Write(f.pending[:1]); err != nil {
			return 0, err
		}
		f.pending = f.pending[1:]
	}
	return n, nil
}
func (f *packetFilter) flush() error { _, err := f.dst.Write(f.pending); f.pending = nil; return err }
