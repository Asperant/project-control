package server

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"syscall"
)

// setUmask sets the process umask and returns the previous value.
//
// Wrapped so the socket-creation path reads clearly and so the platform call is
// in exactly one place.
func setUmask(mask int) int {
	return syscall.Umask(mask)
}

// socketGID reports the group that owns the file at path, via lstat rather
// than stat since a symlink at the socket path must not be followed.
func socketGID(path string) (int, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("cannot read ownership of %s on this platform", path)
	}
	return int(stat.Gid), nil
}

// newBounded wraps a byte slice as a reader for the JSON decoder.
func newBounded(b []byte) io.Reader {
	return bytes.NewReader(b)
}
