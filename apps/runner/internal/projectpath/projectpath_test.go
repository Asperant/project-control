package projectpath

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateAcceptsAGenuineChild(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "my-project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}

	result, err := Validate([]string{root}, project)
	if err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
	if result.Root != root {
		t.Fatalf("Root = %q, want %q", result.Root, root)
	}
	resolvedProject, _ := filepath.EvalSymlinks(project)
	if result.Canonical != resolvedProject {
		t.Fatalf("Canonical = %q, want %q", result.Canonical, resolvedProject)
	}
}

func TestValidateRejectsRelativePath(t *testing.T) {
	root := t.TempDir()
	if _, err := Validate([]string{root}, "relative/path"); !errors.Is(err, ErrNotAbsolute) {
		t.Fatalf("error = %v, want ErrNotAbsolute", err)
	}
}

func TestValidateRejectsExplicitTraversalSegment(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "p")
	_ = os.Mkdir(project, 0o755)

	cases := []string{
		root + "/p/../p",
		root + "/../" + filepath.Base(root),
		"/home/user/Desktop/../../etc/passwd",
	}
	for _, input := range cases {
		if _, err := Validate([]string{root}, input); !errors.Is(err, ErrTraversal) {
			t.Fatalf("Validate(%q) error = %v, want ErrTraversal", input, err)
		}
	}
}

func TestValidateRejectsStringPrefixBypass(t *testing.T) {
	root := t.TempDir()
	// A sibling directory whose name merely starts with root's basename plus a
	// suffix must not be accepted by a naive strings.HasPrefix(candidate, root)
	// check that omits the path-separator boundary.
	evilSibling := root + "-evil"
	if err := os.Mkdir(evilSibling, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := Validate([]string{root}, evilSibling); !errors.Is(err, ErrOutsideAllowedRoot) {
		t.Fatalf("error = %v, want ErrOutsideAllowedRoot", err)
	}
}

func TestValidateRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	escape := filepath.Join(root, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}

	if _, err := Validate([]string{root}, escape); !errors.Is(err, ErrOutsideAllowedRoot) {
		t.Fatalf("error = %v, want ErrOutsideAllowedRoot", err)
	}
}

func TestValidateRejectsSymlinkEscapeViaIntermediateComponent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	nested := filepath.Join(outside, "nested", "project")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	// root/link -> outside, so root/link/nested/project resolves outside root
	// even though the *leaf* component itself is a real directory, not a
	// symlink — only an intermediate path component is.
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}

	if _, err := Validate([]string{root}, filepath.Join(link, "nested", "project")); !errors.Is(err, ErrOutsideAllowedRoot) {
		t.Fatalf("error = %v, want ErrOutsideAllowedRoot", err)
	}
}

func TestValidateRejectsTheAllowedRootItself(t *testing.T) {
	root := t.TempDir()
	if _, err := Validate([]string{root}, root); !errors.Is(err, ErrIsAllowedRootItself) {
		t.Fatalf("error = %v, want ErrIsAllowedRootItself", err)
	}
}

func TestValidateRejectsNonexistentPath(t *testing.T) {
	root := t.TempDir()
	if _, err := Validate([]string{root}, filepath.Join(root, "does-not-exist")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
}

func TestValidateRejectsAFileNotADirectory(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Validate([]string{root}, file); !errors.Is(err, ErrNotDirectory) {
		t.Fatalf("error = %v, want ErrNotDirectory", err)
	}
}

func TestValidateRejectsNullByte(t *testing.T) {
	root := t.TempDir()
	if _, err := Validate([]string{root}, root+"/a\x00b"); !errors.Is(err, ErrMalformed) {
		t.Fatalf("error = %v, want ErrMalformed", err)
	}
}

func TestValidateRejectsEmptyInput(t *testing.T) {
	root := t.TempDir()
	if _, err := Validate([]string{root}, ""); !errors.Is(err, ErrMalformed) {
		t.Fatalf("error = %v, want ErrMalformed", err)
	}
}

func TestValidateWithNoAllowedRoots(t *testing.T) {
	if _, err := Validate(nil, "/tmp"); !errors.Is(err, ErrNoAllowedRoots) {
		t.Fatalf("error = %v, want ErrNoAllowedRoots", err)
	}
}

func TestValidateAcceptsSecondConfiguredRoot(t *testing.T) {
	rootA := t.TempDir()
	rootB := t.TempDir()
	project := filepath.Join(rootB, "p")
	_ = os.Mkdir(project, 0o755)

	result, err := Validate([]string{rootA, rootB}, project)
	if err != nil {
		t.Fatalf("error = %v, want nil", err)
	}
	if result.Root != rootB {
		t.Fatalf("Root = %q, want %q", result.Root, rootB)
	}
}

func TestLoadAllowedRootsParsesAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	rootA := filepath.Join(dir, "a")
	rootB := filepath.Join(dir, "b")
	_ = os.Mkdir(rootA, 0o755)
	_ = os.Mkdir(rootB, 0o755)

	confPath := filepath.Join(dir, "roots.conf")
	content := "# comment\n\n" + rootA + "\n" + rootB + "\n" + rootA + "\n"
	if err := os.WriteFile(confPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	roots, err := LoadAllowedRoots(confPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 2 {
		t.Fatalf("got %d roots, want 2: %v", len(roots), roots)
	}
}

func TestLoadAllowedRootsRejectsRelativeEntry(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "roots.conf")
	if err := os.WriteFile(confPath, []byte("relative/root\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAllowedRoots(confPath); err == nil {
		t.Fatal("expected an error for a relative allowed-root entry")
	}
}

func TestLoadAllowedRootsRejectsEmptyFile(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "roots.conf")
	if err := os.WriteFile(confPath, []byte("# only comments\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAllowedRoots(confPath); err == nil {
		t.Fatal("expected an error for a file with no usable entries")
	}
}

func TestLoadWriteEnabledProjectsParsesAndDeduplicates(t *testing.T) {
	dir := t.TempDir()
	projectA := filepath.Join(dir, "a")
	projectB := filepath.Join(dir, "b")
	_ = os.Mkdir(projectA, 0o755)
	_ = os.Mkdir(projectB, 0o755)

	confPath := filepath.Join(dir, "write-enabled.conf")
	content := "# comment\n\n" + projectA + "\n" + projectB + "\n" + projectA + "\n"
	if err := os.WriteFile(confPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	projects, err := LoadWriteEnabledProjects(confPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 2 {
		t.Fatalf("got %d projects, want 2: %v", len(projects), projects)
	}
}

func TestLoadWriteEnabledProjectsMissingFileIsEmptyNotError(t *testing.T) {
	dir := t.TempDir()
	projects, err := LoadWriteEnabledProjects(filepath.Join(dir, "does-not-exist.conf"))
	if err != nil {
		t.Fatalf("missing write-enabled file must not be an error, got %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("got %d projects, want 0", len(projects))
	}
}

func TestLoadWriteEnabledProjectsEmptyFileIsEmptyNotError(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "write-enabled.conf")
	if err := os.WriteFile(confPath, []byte("# only comments\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	projects, err := LoadWriteEnabledProjects(confPath)
	if err != nil {
		t.Fatalf("an all-comment write-enabled file must not be an error, got %v", err)
	}
	if len(projects) != 0 {
		t.Fatalf("got %d projects, want 0", len(projects))
	}
}

func TestLoadWriteEnabledProjectsRejectsRelativeEntry(t *testing.T) {
	dir := t.TempDir()
	confPath := filepath.Join(dir, "write-enabled.conf")
	if err := os.WriteFile(confPath, []byte("relative/project\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadWriteEnabledProjects(confPath); err == nil {
		t.Fatal("expected an error for a relative write-enabled entry")
	}
}

func TestValidateWritableAcceptsAnExactlyListedProject(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "my-project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	resolvedProject, _ := filepath.EvalSymlinks(project)

	result, err := ValidateWritable([]string{root}, []string{resolvedProject}, project)
	if err != nil {
		t.Fatalf("ValidateWritable() error = %v, want nil", err)
	}
	if result.Canonical != resolvedProject {
		t.Fatalf("Canonical = %q, want %q", result.Canonical, resolvedProject)
	}
}

func TestValidateWritableRejectsAProjectNotOnTheList(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "my-project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := ValidateWritable([]string{root}, nil, project); !errors.Is(err, ErrWriteNotEnabled) {
		t.Fatalf("error = %v, want ErrWriteNotEnabled", err)
	}
}

func TestValidateWritableRejectsADescendantOfAWriteEnabledProject(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "my-project")
	nested := filepath.Join(project, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	resolvedProject, _ := filepath.EvalSymlinks(project)

	// Enabling writes for `project` must not silently enable writes for a
	// directory nested underneath it: ValidateWritable requires an exact
	// match, never a prefix match.
	if _, err := ValidateWritable([]string{root}, []string{resolvedProject}, nested); !errors.Is(err, ErrWriteNotEnabled) {
		t.Fatalf("error = %v, want ErrWriteNotEnabled", err)
	}
}

func TestValidateWritablePropagatesUnderlyingValidateErrors(t *testing.T) {
	root := t.TempDir()
	if _, err := ValidateWritable([]string{root}, nil, "relative/path"); !errors.Is(err, ErrNotAbsolute) {
		t.Fatalf("error = %v, want ErrNotAbsolute", err)
	}
}

func TestWithinRoot(t *testing.T) {
	if !WithinRoot("/a/b", "/a/b/c") {
		t.Fatal("expected /a/b/c to be within /a/b")
	}
	if WithinRoot("/a/b", "/a/b") {
		t.Fatal("root itself must not be considered within root")
	}
	if WithinRoot("/a/b", "/a/b-evil/c") {
		t.Fatal("prefix bypass must be rejected")
	}
}
