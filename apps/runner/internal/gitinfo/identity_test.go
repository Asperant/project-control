package gitinfo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestContentHashMatchesRealGitHashObject cross-verifies gitBlobHash against
// the actual git binary, not just our own understanding of the algorithm —
// the whole point of using git's own object-id scheme is that it can be
// checked against git itself.
func TestContentHashMatchesRealGitHashObject(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("git", "hash-object", "f.txt")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git hash-object: %v: %s", err, out)
	}
	want := strings.TrimSpace(string(out))

	got := ComputePathIdentities(dir, []string{"f.txt"})[0]
	if got.ContentHash != want {
		t.Fatalf("ContentHash = %s, want %s (git hash-object)", got.ContentHash, want)
	}
	if got.Mode != "100644" {
		t.Fatalf("Mode = %s, want 100644", got.Mode)
	}
}

func TestContentHashMatchesRealGitHashObjectForEmptyFile(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "empty.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "hash-object", "empty.txt")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git hash-object: %v: %s", err, out)
	}
	want := strings.TrimSpace(string(out))
	got := ComputePathIdentities(dir, []string{"empty.txt"})[0]
	if got.ContentHash != want {
		t.Fatalf("ContentHash = %s, want %s (git hash-object)", got.ContentHash, want)
	}
}

func TestSymlinkContentHashMatchesRealGitHashObjectOfTarget(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	if err := os.Symlink("./f.txt", filepath.Join(dir, "link.txt")); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", "-c", "printf '%s' './f.txt' | git hash-object --stdin")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git hash-object --stdin: %v: %s", err, out)
	}
	want := strings.TrimSpace(string(out))

	got := ComputePathIdentities(dir, []string{"link.txt"})[0]
	if got.Kind != PathIdentitySymlink {
		t.Fatalf("Kind = %s, want symlink", got.Kind)
	}
	if got.ContentHash != want {
		t.Fatalf("ContentHash = %s, want %s (git hash-object of the link target text)", got.ContentHash, want)
	}
	if got.Mode != "120000" {
		t.Fatalf("Mode = %s, want 120000", got.Mode)
	}
}

// TestContentHashCatchesTheExactSizeAndMtimePreservingEditScenario is the
// regression test for the actual gap that motivated this file: a file edited
// so its byte count is unchanged and its mtime is restored to the original
// value (touch -d, cp -p, rsync -a, or simply an editor/tool that preserves
// timestamps all produce this — no adversarial intent required). A
// size+mtime-only fingerprint cannot distinguish this from "nothing
// changed"; the content hash must.
func TestContentHashCatchesTheExactSizeAndMtimePreservingEditScenario(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	fixedMtime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	if err := os.WriteFile(path, []byte("aaaaaaaaaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	before := ComputePathIdentities(dir, []string{"f.txt"})[0]

	if err := os.WriteFile(path, []byte("bbbbbbbbbb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	after := ComputePathIdentities(dir, []string{"f.txt"})[0]

	if before.ContentHash == after.ContentHash {
		t.Fatal("content hash did not change despite different content at identical size and mtime — the exact gap this function exists to close")
	}
}

func TestContentHashChangesWhenOnlyModeChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.sh")
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := ComputePathIdentities(dir, []string{"f.sh"})[0]

	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	after := ComputePathIdentities(dir, []string{"f.sh"})[0]

	if before.Mode == after.Mode {
		t.Fatalf("Mode did not change after chmod +x: before=%s after=%s", before.Mode, after.Mode)
	}
	if before.ContentHash != after.ContentHash {
		t.Fatal("ContentHash changed on a chmod with byte-identical content; it should be Mode that captures this, not the content hash")
	}
	if after.Mode != "100755" {
		t.Fatalf("Mode = %s, want 100755", after.Mode)
	}
}

func TestAbsentPathIsStableAndDistinctRegardlessOfPriorState(t *testing.T) {
	dir := t.TempDir()
	got := ComputePathIdentities(dir, []string{"never-existed.txt"})[0]
	if got.Kind != PathIdentityAbsent {
		t.Fatalf("Kind = %s, want absent", got.Kind)
	}
	if got.ContentHash != "" || got.Mode != "" {
		t.Fatalf("absent path carries content hash or mode: %+v", got)
	}
}

func TestDeletedFileIsDetectedAsAbsent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(path, []byte("here\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := ComputePathIdentities(dir, []string{"f.txt"})[0]
	if before.Kind != PathIdentityFile {
		t.Fatalf("Kind = %s, want file", before.Kind)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	after := ComputePathIdentities(dir, []string{"f.txt"})[0]
	if after.Kind != PathIdentityAbsent {
		t.Fatalf("Kind = %s, want absent after deletion", after.Kind)
	}
}

func TestComputePathIdentitiesRejectsTraversalAndAbsolutePaths(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "outside-secret.txt")
	if err := os.WriteFile(outside, []byte("must never be read"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(outside)

	for _, hostile := range []string{
		"../outside-secret.txt",
		"a/../../outside-secret.txt",
		outside, // absolute path
		"/etc/passwd",
	} {
		got := ComputePathIdentities(dir, []string{hostile})[0]
		if got.Kind != PathIdentityUnsupported || got.UnsupportedReason != "invalid_path" {
			t.Fatalf("hostile path %q was not rejected as invalid_path: %+v", hostile, got)
		}
		if got.ContentHash != "" {
			t.Fatalf("hostile path %q leaked a content hash: %+v", hostile, got)
		}
	}
}

func TestComputePathIdentitiesDoesNotFollowASymlinkEscapingTheRepository(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "outside-secret-2.txt")
	if err := os.WriteFile(outside, []byte("must never be read"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(outside)
	if err := os.Symlink(outside, filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatal(err)
	}

	got := ComputePathIdentities(dir, []string{"escape.txt"})[0]
	if got.Kind != PathIdentitySymlink {
		t.Fatalf("Kind = %s, want symlink (the link itself, never its target's content)", got.Kind)
	}
	// The identity must be of the *link text* (the outside path string),
	// never bytes read from the target file — ComputePathIdentities never
	// opens the file the symlink points to.
	if got.ContentHash != gitBlobHash([]byte(outside)) {
		t.Fatal("symlink identity does not match hashing the link target text alone")
	}
}

func TestOversizedFileFallsBackToSizeAndMtimeAndStaysBounded(t *testing.T) {
	original := MaxContentHashBytes
	MaxContentHashBytes = 16
	t.Cleanup(func() { MaxContentHashBytes = original })

	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(path, []byte("this is more than sixteen bytes long"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := ComputePathIdentities(dir, []string{"big.bin"})[0]
	if got.Kind != PathIdentityUnsupported || got.UnsupportedReason != "oversized" {
		t.Fatalf("got = %+v, want Kind=unsupported reason=oversized", got)
	}
	if got.ContentHash != "" {
		t.Fatal("an oversized file must never be hashed (that is the entire point of the bound)")
	}
	if got.FallbackSize == 0 || got.FallbackModifiedAt == "" {
		t.Fatalf("oversized fallback missing size/mtime signal: %+v", got)
	}
}

func TestOversizedFileFallbackStillDetectsAChange(t *testing.T) {
	original := MaxContentHashBytes
	MaxContentHashBytes = 16
	t.Cleanup(func() { MaxContentHashBytes = original })

	dir := t.TempDir()
	path := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(path, []byte("this is more than sixteen bytes long"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := ComputePathIdentities(dir, []string{"big.bin"})[0]

	if err := os.WriteFile(path, []byte("this is more than sixteen bytes long, but different!!"), 0o644); err != nil {
		t.Fatal(err)
	}
	after := ComputePathIdentities(dir, []string{"big.bin"})[0]

	if before.FallbackSize == after.FallbackSize {
		t.Fatal("oversized fallback did not detect a size change")
	}
}

func TestComputePathIdentitiesIsBoundedForManyFiles(t *testing.T) {
	dir := t.TempDir()
	paths := make([]string, 0, 200)
	for i := 0; i < 200; i++ {
		name := filepath.Base(t.TempDir()) + ".txt" // cheap unique-ish name
		full := filepath.Join(dir, name)
		if err := os.WriteFile(full, []byte("content"), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, name)
	}
	start := time.Now()
	results := ComputePathIdentities(dir, paths)
	if len(results) != len(paths) {
		t.Fatalf("got %d results, want %d", len(results), len(paths))
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("200 small-file identities took %s, expected near-instant", elapsed)
	}
}

func TestComputePathIdentitiesResultOrderMatchesInputOrder(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := ComputePathIdentities(dir, []string{"c.txt", "a.txt", "b.txt"})
	want := []string{"c.txt", "a.txt", "b.txt"}
	for i, id := range got {
		if id.Path != want[i] {
			t.Fatalf("result[%d].Path = %s, want %s", i, id.Path, want[i])
		}
	}
}
