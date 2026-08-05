package registry

import (
	"bytes"
	"io"
)

// newLimitedReader wraps raw JSON in a reader bounded to its own length.
//
// Trivial today, but it keeps the decoder construction in one place so a future
// change that streams parameters from the socket cannot accidentally hand the
// decoder an unbounded source.
func newLimitedReader(raw []byte) io.Reader {
	return io.LimitReader(bytes.NewReader(raw), int64(len(raw)))
}
