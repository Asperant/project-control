package operations

import (
	"context"
	"errors"
	"fmt"

	"github.com/project-control/runner/internal/gitinfo"
	"github.com/project-control/runner/internal/gitwrite"
	"github.com/project-control/runner/internal/projectpath"
	"github.com/project-control/runner/internal/registry"
)

// writeValidationReason extends validationReason with the one additional
// rejection ValidateWritable can produce over plain Validate.
func writeValidationReason(err error) string {
	if errors.Is(err, projectpath.ErrWriteNotEnabled) {
		return "write_not_enabled"
	}
	return validationReason(err)
}

func preflightToMap(state gitwrite.PreflightResult) map[string]any {
	return map[string]any{
		"gitLayoutSupported": state.GitLayoutSupported,
		"branch":             nullableString(state.Branch),
		"detached":           state.Detached,
		"headSha":            nullableString(state.HeadSHA),
		"unborn":             state.Unborn,
		"mergeInProgress":    state.MergeInProgress,
		"unmergedPaths":      state.UnmergedPaths,
		"identityConfigured": state.IdentityConfigured,
	}
}

func pathIdentityToMap(id gitinfo.PathIdentity) map[string]any {
	return map[string]any{
		"path": id.Path, "kind": string(id.Kind),
		"contentHash": nullableString(id.ContentHash), "mode": nullableString(id.Mode),
		"unsupportedReason":  nullableString(id.UnsupportedReason),
		"fallbackSize":       id.FallbackSize,
		"fallbackModifiedAt": nullableString(id.FallbackModifiedAt),
	}
}

// projectGitWriteStatus implements `project.git.write.status`: whether a
// project may accept a project.git.commit right now, and if not, exactly
// which precondition is unmet. Read-only — it calls gitwrite.Preflight and,
// when the caller supplies paths, gitinfo.ComputePathIdentities; it never
// calls gitwrite.Commit.
//
// The optional paths/pathIdentities pair exists for one purpose: Repository
// Actions' plan/execute fingerprint (see
// apps/control-api/src/repository-actions/plan.ts) needs a bounded, content-
// aware signal for exactly the paths a plan selected, not the whole working
// tree, and not persisted anywhere — computed fresh on every call, folded
// into a single sha256 by the caller, never stored or returned again.
func projectGitWriteStatus(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		validated, verr := projectpath.ValidateWritable(cfg.AllowedProjectRoots, cfg.WriteEnabledProjects, pathParam(params))
		if verr != nil {
			return map[string]any{"valid": false, "reason": writeValidationReason(verr)}, nil
		}
		if !gitwrite.Available() {
			return map[string]any{
				"valid": true, "canonicalPath": validated.Canonical, "allowedRoot": validated.Root,
				"writable": false, "reason": "git_unavailable",
			}, nil
		}

		state, err := gitwrite.Preflight(ctx, validated.Canonical)
		if err != nil {
			return nil, fmt.Errorf("write preflight failed: %w", err)
		}
		out := map[string]any{
			"valid": true, "canonicalPath": validated.Canonical, "allowedRoot": validated.Root,
			"writable":      true,
			"preflight":     preflightToMap(state),
			"readyToCommit": readyReason(state),
		}

		if requested := stringSliceParam(params, "paths"); requested != nil {
			identities := gitinfo.ComputePathIdentities(validated.Canonical, requested)
			mapped := make([]any, 0, len(identities))
			for _, id := range identities {
				mapped = append(mapped, pathIdentityToMap(id))
			}
			out["pathIdentities"] = mapped
		}
		return out, nil
	}
}

// readyReason reports "" when every precondition holds, or the single stable
// reason code the caller would receive from project.git.commit if it tried
// right now. Checked in the same order Commit itself enforces them.
func readyReason(state gitwrite.PreflightResult) string {
	switch {
	case !state.GitLayoutSupported:
		return "unsupported_git_layout"
	case state.Detached:
		return "detached_head"
	case state.MergeInProgress:
		return "merge_in_progress"
	case state.UnmergedPaths:
		return "unmerged_paths"
	case !state.IdentityConfigured:
		return "commit_identity_missing"
	default:
		return ""
	}
}

func stringSliceParam(params map[string]any, name string) []string {
	raw, ok := params[name].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		s, ok := item.(string)
		if !ok {
			continue
		}
		out = append(out, s)
	}
	return out
}

// commitReason maps a gitwrite sentinel error to the stable, machine-readable
// reason code the Control API branches on. Any error not recognised here
// (an I/O failure, an unexpected git failure) is treated as an operation
// failure by the caller rather than a "valid": false / "reason" result — the
// distinction matters because those two shapes mean different things to the
// Control API's execute-then-verify flow.
func commitReason(err error) (string, bool) {
	switch {
	case errors.Is(err, gitwrite.ErrUnsupportedGitLayout):
		return "unsupported_git_layout", true
	case errors.Is(err, gitwrite.ErrDetachedHead):
		return "detached_head", true
	case errors.Is(err, gitwrite.ErrBranchMismatch):
		return "branch_mismatch", true
	case errors.Is(err, gitwrite.ErrHeadMoved):
		return "head_moved", true
	case errors.Is(err, gitwrite.ErrMergeInProgress):
		return "merge_in_progress", true
	case errors.Is(err, gitwrite.ErrUnmergedPaths):
		return "unmerged_paths", true
	case errors.Is(err, gitwrite.ErrCommitIdentityMissing):
		return "commit_identity_missing", true
	case errors.Is(err, gitwrite.ErrProtectedPathSelected):
		return "protected_path_selected", true
	case errors.Is(err, gitwrite.ErrSubmodulePathSelected):
		return "submodule_path_selected", true
	case errors.Is(err, gitwrite.ErrEmptySelection):
		return "empty_selection", true
	case errors.Is(err, gitwrite.ErrInvalidPath):
		return "invalid_path", true
	case errors.Is(err, gitwrite.ErrEmptyMessage):
		return "empty_message", true
	default:
		return "", false
	}
}

// projectGitCommit implements `project.git.commit`, the runner's only
// mutating operation. See internal/gitwrite's package doc for what makes the
// underlying git sequence safe; this handler's job is limited to path
// validation against the write-enabled list and translating gitwrite's
// sentinel errors into the stable result shape the Control API expects.
func projectGitCommit(cfg Config) registry.Handler {
	return func(ctx context.Context, params map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		validated, verr := projectpath.ValidateWritable(cfg.AllowedProjectRoots, cfg.WriteEnabledProjects, pathParam(params))
		if verr != nil {
			return map[string]any{"valid": false, "reason": writeValidationReason(verr)}, nil
		}

		branch, _ := params["branch"].(string)
		expectedHead, _ := params["expectedHead"].(string)
		message, _ := params["message"].(string)
		paths := stringSliceParam(params, "paths")

		result, err := gitwrite.Commit(ctx, validated.Canonical, gitwrite.CommitOptions{
			Branch: branch, ExpectedHead: expectedHead, Message: message, Paths: paths,
		})
		if err != nil {
			if reason, known := commitReason(err); known {
				return map[string]any{
					"valid": true, "canonicalPath": validated.Canonical, "allowedRoot": validated.Root,
					"committed": false, "reason": reason,
				}, nil
			}
			return nil, fmt.Errorf("commit failed: %w", err)
		}

		return map[string]any{
			"valid": true, "canonicalPath": validated.Canonical, "allowedRoot": validated.Root,
			"committed": true,
			"commit": map[string]any{
				"sha": result.CommitSHA, "shortSha": result.ShortSHA,
				"previousHeadSha": nullableString(result.PreviousHeadSHA),
				"branch":          result.Branch, "fileCount": result.FileCount,
				"indexReconciled": result.IndexReconciled,
			},
		}, nil
	}
}
