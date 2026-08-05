module github.com/project-control/runner

go 1.26

// No third-party dependencies, by design.
//
// The runner is the one component that runs on the host outside a container,
// with filesystem access to the deployment root. Every dependency it takes on is
// code that inherits that position, so it uses only the Go standard library:
// nothing to audit beyond this repository, and nothing that can be compromised
// upstream between releases.
