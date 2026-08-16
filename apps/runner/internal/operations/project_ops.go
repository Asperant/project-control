package operations

import (
	"context"
	"errors"
	"fmt"

	"github.com/project-control/runner/internal/detect"
	"github.com/project-control/runner/internal/gitinfo"
	"github.com/project-control/runner/internal/projectpath"
	"github.com/project-control/runner/internal/registry"
)

// scanVersion is recorded on every inspection result so the Control API can
// tell whether a stored inspection came from an older detector than the one
// currently running, and treat it conservatively (e.g. require a fresh scan)
// if so. Bump it whenever detect's or gitinfo's output shape changes.
const scanVersion = "1"

// validationReason maps a projectpath error to a stable, machine-readable
// code. Callers (the Control API, ultimately the web panel) branch on this
// string rather than parsing an English sentence, and it is safe to return to
// an authenticated admin caller: none of these leak anything about the
// filesystem beyond "this path did or didn't qualify".
func validationReason(err error) string {
	switch {
	case errors.Is(err, projectpath.ErrNoAllowedRoots):
		return "no_allowed_roots_configured"
	case errors.Is(err, projectpath.ErrMalformed):
		return "malformed_path"
	case errors.Is(err, projectpath.ErrNotAbsolute):
		return "not_absolute"
	case errors.Is(err, projectpath.ErrTraversal):
		return "traversal_rejected"
	case errors.Is(err, projectpath.ErrNotFound):
		return "not_found"
	case errors.Is(err, projectpath.ErrNotDirectory):
		return "not_a_directory"
	case errors.Is(err, projectpath.ErrIsAllowedRootItself):
		return "is_allowed_root"
	case errors.Is(err, projectpath.ErrOutsideAllowedRoot):
		return "outside_allowed_roots"
	default:
		return "invalid_path"
	}
}

func pathParam(params map[string]any) string {
	raw, _ := params["path"].(string)
	return raw
}

// projectPathValidate implements `project.path.validate`.
func projectPathValidate(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result, err := projectpath.Validate(cfg.AllowedProjectRoots, pathParam(params))
		if err != nil {
			return map[string]any{"valid": false, "reason": validationReason(err)}, nil
		}
		return map[string]any{
			"valid":         true,
			"canonicalPath": result.Canonical,
			"allowedRoot":   result.Root,
		}, nil
	}
}

// projectGitSummary implements `project.git.summary`.
func projectGitSummary(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		validated, verr := projectpath.Validate(cfg.AllowedProjectRoots, pathParam(params))
		if verr != nil {
			return map[string]any{"valid": false, "reason": validationReason(verr)}, nil
		}

		out := map[string]any{
			"valid":         true,
			"canonicalPath": validated.Canonical,
			"allowedRoot":   validated.Root,
			"gitAvailable":  gitinfo.Available(),
		}
		if !gitinfo.Available() {
			return out, nil
		}

		summary, gerr := gitinfo.Summarise(ctx, validated.Canonical)
		if gerr != nil {
			return nil, fmt.Errorf("git summary failed: %w", gerr)
		}
		out["git"] = gitSummaryToMap(summary)
		return out, nil
	}
}

// projectGitDevelopment implements the narrowly typed, read-only
// `project.git.development` operation. Git failures are represented in the
// returned machine model so an observational problem does not become a runner
// transport failure.
func projectGitDevelopment(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		validated, verr := projectpath.Validate(cfg.AllowedProjectRoots, pathParam(params))
		if verr != nil {
			return map[string]any{"valid": false, "reason": validationReason(verr)}, nil
		}
		development, err := gitinfo.InspectDevelopment(ctx, validated.Canonical)
		if err != nil {
			return nil, fmt.Errorf("git development inspection failed: %w", err)
		}
		return map[string]any{
			"valid":         true,
			"canonicalPath": validated.Canonical,
			"allowedRoot":   validated.Root,
			"development":   gitDevelopmentToMap(development),
		}, nil
	}
}

// projectInspect implements `project.inspect`: path validation, git summary
// and manifest/technology detection in one bounded pass.
func projectInspect(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		validated, verr := projectpath.Validate(cfg.AllowedProjectRoots, pathParam(params))
		if verr != nil {
			return map[string]any{"valid": false, "reason": validationReason(verr)}, nil
		}

		out := map[string]any{
			"valid":         true,
			"canonicalPath": validated.Canonical,
			"allowedRoot":   validated.Root,
			"scanVersion":   scanVersion,
			"gitAvailable":  gitinfo.Available(),
		}

		if gitinfo.Available() {
			summary, gerr := gitinfo.Summarise(ctx, validated.Canonical)
			if gerr != nil {
				out["gitWarning"] = "git information could not be read"
			} else {
				out["git"] = gitSummaryToMap(summary)
			}
		}

		if err := ctx.Err(); err != nil {
			return nil, err
		}

		scan, serr := detect.Scan(ctx, validated.Canonical, detect.DefaultLimits())
		if serr != nil {
			return nil, fmt.Errorf("technology scan failed: %w", serr)
		}

		technologies := make([]any, 0, len(scan.Technologies))
		for _, tech := range scan.Technologies {
			technologies = append(technologies, map[string]any{
				"name":         tech.Name,
				"category":     tech.Category,
				"version":      tech.Version,
				"evidencePath": tech.EvidencePath,
			})
		}
		commands := make([]any, 0, len(scan.Commands))
		for _, cmd := range scan.Commands {
			commands = append(commands, map[string]any{
				"type":             cmd.Type,
				"displayName":      cmd.DisplayName,
				"commandText":      cmd.CommandText,
				"workingDirectory": cmd.WorkingDirectory,
				"evidencePath":     cmd.EvidencePath,
			})
		}

		out["technologies"] = technologies
		out["commands"] = commands
		out["manifests"] = toAnySlice(scan.Manifests)
		out["warnings"] = toAnySlice(scan.Warnings)
		out["limitsHit"] = toAnySlice(scan.LimitsHit)

		return out, nil
	}
}

func gitSummaryToMap(s gitinfo.Summary) map[string]any {
	remotes := make([]any, 0, len(s.Remotes))
	for _, r := range s.Remotes {
		remotes = append(remotes, map[string]any{"name": r.Name, "url": r.URL})
	}
	return map[string]any{
		"present":                 s.Present,
		"topLevelPath":            s.TopLevelPath,
		"remotes":                 remotes,
		"activeBranch":            s.ActiveBranch,
		"detached":                s.Detached,
		"defaultBranch":           s.DefaultBranch,
		"defaultBranchConfidence": s.DefaultBranchConfidence,
		"lastCommitHash":          s.LastCommitHash,
		"lastCommitShortHash":     s.LastCommitShortHash,
		"lastCommitAt":            s.LastCommitAtRFC3339,
		"lastCommitSubject":       s.LastCommitSubject,
		"isDirty":                 s.IsDirty,
		"modifiedCount":           s.ModifiedCount,
		"untrackedCount":          s.UntrackedCount,
	}
}

func gitDevelopmentToMap(d gitinfo.Development) map[string]any {
	files := make([]any, 0, len(d.Files))
	for _, f := range d.Files {
		files = append(files, map[string]any{
			"path": f.Path, "oldPath": nullableString(f.OldPath), "state": f.State,
			"staged": f.Staged, "unstaged": f.Unstaged, "untracked": f.Untracked,
			"size": f.Size, "modifiedAt": nullableString(f.ModifiedAt),
		})
	}
	commits := make([]any, 0, len(d.RecentCommits))
	for _, c := range d.RecentCommits {
		commits = append(commits, map[string]any{
			"sha": c.SHA, "shortSha": c.ShortSHA, "subject": c.Subject,
			"authorName": c.AuthorName, "authoredAt": c.AuthoredAt,
		})
	}
	var remote any
	if d.Remote != nil {
		remote = map[string]any{
			"name": d.Remote.Name, "rawUrl": nullableString(d.Remote.RawURL),
			"host": nullableString(d.Remote.Host), "owner": nullableString(d.Remote.Owner),
			"repository":     nullableString(d.Remote.Repository),
			"trackingBranch": nullableString(d.Remote.TrackingBranch),
			"ahead":          d.Remote.Ahead, "behind": d.Remote.Behind,
			"comparisonBasis": d.Remote.ComparisonBasis,
		}
	}
	return map[string]any{
		"repository": map[string]any{
			"available": d.Repository.Available, "isRepository": d.Repository.IsRepository,
			"errorCode": nullableString(d.Repository.ErrorCode),
		},
		"head": map[string]any{
			"sha": nullableString(d.Head.SHA), "shortSha": nullableString(d.Head.ShortSHA),
			"branch": nullableString(d.Head.Branch), "detached": d.Head.Detached, "unborn": d.Head.Unborn,
		},
		"workingTree": map[string]any{
			"clean": d.WorkingTree.Clean, "stagedCount": d.WorkingTree.StagedCount,
			"unstagedCount": d.WorkingTree.UnstagedCount, "untrackedCount": d.WorkingTree.UntrackedCount,
			"conflictedCount": d.WorkingTree.ConflictedCount, "totalChangedCount": d.WorkingTree.TotalChangedCount,
			"filesTruncated": d.WorkingTree.FilesTruncated,
		},
		"files": files, "recentCommits": commits, "remote": remote,
		"github": map[string]any{"detected": d.GitHub.Detected, "configured": d.GitHub.Configured, "status": d.GitHub.Status},
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func toAnySlice(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}
