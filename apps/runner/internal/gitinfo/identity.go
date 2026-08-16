package gitinfo

import (
	"crypto/sha1" //nolint:gosec // content-addressing identity, not a security signature — see gitBlobHash doc.
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxContentHashBytes bounds how large a single working-tree file this
// package will read in full to compute a content identity. Source files are
// essentially always far smaller than this; a file at or above the bound is
// reported as PathIdentityUnsupported with reason "oversized" (falling back
// to the weaker size/mtime signal used before content hashing existed)
// instead of being hashed, so one oversized selection can never make a
// single ComputePathIdentities call, or the read serving it, unbounded.
//
// A package-level var, not a const, so tests can shrink it rather than
// materialising an 8 MiB fixture — matching the gitPath var pattern already
// used elsewhere in this package for the same reason.
var MaxContentHashBytes int64 = 8 << 20 // 8 MiB

// PathIdentityKind classifies what ComputePathIdentities found at a path.
type PathIdentityKind string

const (
	PathIdentityFile        PathIdentityKind = "file"
	PathIdentitySymlink     PathIdentityKind = "symlink"
	PathIdentityAbsent      PathIdentityKind = "absent"
	PathIdentityUnsupported PathIdentityKind = "unsupported"
)

// PathIdentity is a bounded, deterministic identity of one repository-
// relative path's *current* working-tree content — never the content
// itself, and never anything derived from history or the index.
type PathIdentity struct {
	Path string
	Kind PathIdentityKind
	// ContentHash is the git blob object id (see gitBlobHash) of the current
	// working-tree bytes. Set only when Kind is PathIdentityFile or
	// PathIdentitySymlink.
	ContentHash string
	// Mode is a git tree-entry mode string ("100644", "100755", "120000").
	// Set only when Kind is PathIdentityFile or PathIdentitySymlink, so a
	// chmod with byte-identical content still changes the identity.
	Mode string
	// UnsupportedReason explains Kind == PathIdentityUnsupported:
	// "oversized", "not_a_regular_file", "invalid_path", "unreadable", or
	// "unreadable_symlink".
	UnsupportedReason string
	// FallbackSize/FallbackModifiedAt are populated only when
	// UnsupportedReason == "oversized" — the one case a full content read is
	// deliberately refused, so callers still have *some* change signal
	// rather than none. This is a known, narrower guarantee than the
	// content-hash path and is documented as such in
	// docs/repository-actions.md; it is not silently presented as
	// equivalent.
	FallbackSize       int64
	FallbackModifiedAt string
}

// ComputePathIdentities reports a bounded, deterministic identity for each of
// paths as it currently exists on disk under dir. dir must already be the
// canonical, validated project directory (projectpath.Validate's output);
// each individual path is independently re-validated and re-contained here
// as defense in depth, since this function has its own, narrower callers and
// must not depend on having been invoked only after that check.
//
// Every path is resolved with filepath.Join and confirmed to remain a
// component-wise descendant of dir before anything is opened — the same
// containment rule projectpath.Validate and gitwrite's own path checks
// apply — so a caller-supplied ".." or absolute path can never read outside
// the repository. A path that is itself a symlink is never followed to
// determine its identity: its blob content, per git's own model, *is* the
// link target text (read via os.Readlink), not the bytes at whatever the
// link points to. This is what makes a symlink pointed outside the
// repository safe to identify without ever opening the file it points at.
func ComputePathIdentities(dir string, paths []string) []PathIdentity {
	results := make([]PathIdentity, 0, len(paths))
	for _, p := range paths {
		results = append(results, identityFor(dir, p))
	}
	return results
}

func identityFor(dir, relPath string) PathIdentity {
	if !filepath.IsAbs(dir) || !safeRepositoryRelativePath(relPath) {
		return PathIdentity{Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "invalid_path"}
	}
	cleanDir := filepath.Clean(dir)
	full := filepath.Join(cleanDir, relPath)
	if full != cleanDir && !strings.HasPrefix(full, cleanDir+string(filepath.Separator)) {
		return PathIdentity{Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "invalid_path"}
	}

	info, err := os.Lstat(full)
	if err != nil {
		return PathIdentity{Path: relPath, Kind: PathIdentityAbsent}
	}

	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(full)
		if err != nil {
			return PathIdentity{Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "unreadable_symlink"}
		}
		return PathIdentity{Path: relPath, Kind: PathIdentitySymlink, Mode: "120000", ContentHash: gitBlobHash([]byte(target))}
	case info.Mode().IsRegular():
		if info.Size() > MaxContentHashBytes {
			return PathIdentity{
				Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "oversized",
				FallbackSize: info.Size(), FallbackModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
			}
		}
		hash, err := hashFileContent(full, info.Size())
		if err != nil {
			return PathIdentity{Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "unreadable"}
		}
		mode := "100644"
		if info.Mode()&0o111 != 0 {
			mode = "100755"
		}
		return PathIdentity{Path: relPath, Kind: PathIdentityFile, Mode: mode, ContentHash: hash}
	default:
		// A directory (including a submodule checkout), device, socket or
		// FIFO — none of these can ever be a valid git.commit selection.
		// gitwrite independently rejects a submodule path at commit time;
		// this function only needs to represent the state safely, not
		// enforce that rejection itself.
		return PathIdentity{Path: relPath, Kind: PathIdentityUnsupported, UnsupportedReason: "not_a_regular_file"}
	}
}

// gitBlobHash reproduces git's own blob object id algorithm exactly:
// sha1("blob " + decimal-length + NUL + content). This is a content-identity
// choice, not a security signature: nothing here relies on collision
// resistance, only on "different content almost certainly produces a
// different value" — the same property git itself relies on for every blob
// in every repository using this platform. Using git's own algorithm rather
// than a bespoke one also means the value is directly comparable to
// `git hash-object <path>` or a `git ls-tree` entry, which is useful when
// debugging a fingerprint mismatch by hand.
func gitBlobHash(content []byte) string {
	h := sha1.New() //nolint:gosec
	fmt.Fprintf(h, "blob %d\x00", len(content))
	h.Write(content)
	return hex.EncodeToString(h.Sum(nil))
}

// hashFileContent reads exactly sizeHint bytes and hashes them. It reads one
// byte beyond sizeHint to detect a TOCTOU race (the file grew after it was
// stat-ed) and fails closed rather than silently hashing a truncated,
// length-mismatched prefix; a race in the other direction (the file shrank)
// is caught the same way, by the byte count read not matching sizeHint.
func hashFileContent(path string, sizeHint int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	buf := make([]byte, sizeHint+1)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", err
	}
	if int64(n) != sizeHint {
		return "", fmt.Errorf("gitinfo: %s size changed while reading (expected %d, read %d)", path, sizeHint, n)
	}
	return gitBlobHash(buf[:n]), nil
}
