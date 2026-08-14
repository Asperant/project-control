import type {
  ProjectCommand,
  ProjectDetail,
  ProjectLocation,
  ProjectRepository,
  ProjectRule,
  ProjectSummary,
  ProjectTechnology,
} from '@project-control/contracts';
import type { ProjectCommandRow, ProjectRow, ProjectRuleRow, ProjectTechnologyRow } from './types.js';

function toLocation(row: ProjectRow): ProjectLocation {
  return {
    inputPath: row.location_input_path,
    canonicalPath: row.location_canonical_path,
    allowedRoot: row.location_allowed_root,
    accessible: row.location_accessible,
    checkedAt: row.location_checked_at.toISOString(),
  };
}

function toRepository(row: ProjectRow): ProjectRepository {
  return {
    present: row.repo_present,
    topLevelPath: row.repo_top_level_path,
    remotes: row.repo_remotes,
    normalizedIdentity: row.repo_normalized_identity,
    activeBranch: row.repo_active_branch,
    defaultBranch: row.repo_default_branch,
    defaultBranchConfidence: row.repo_default_branch_confidence,
    lastCommitHash: row.repo_last_commit_hash,
    lastCommitShortHash: row.repo_last_commit_short_hash,
    lastCommitAt: row.repo_last_commit_at ? row.repo_last_commit_at.toISOString() : null,
    lastCommitSubject: row.repo_last_commit_subject,
    isDirty: row.repo_is_dirty,
    modifiedCount: row.repo_modified_count,
    untrackedCount: row.repo_untracked_count,
    scannedAt: row.repo_scanned_at ? row.repo_scanned_at.toISOString() : null,
  };
}

export function toProjectTechnology(row: ProjectTechnologyRow): ProjectTechnology {
  return {
    id: row.id,
    name: row.name,
    category: row.category as ProjectTechnology['category'],
    version: row.version,
    detectionSource: row.detection_source,
    evidencePath: row.evidence_path,
    isUserDefined: row.is_user_defined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toProjectRule(row: ProjectRuleRow): ProjectRule {
  return {
    id: row.id,
    category: row.category as ProjectRule['category'],
    text: row.text,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toProjectCommand(row: ProjectCommandRow): ProjectCommand {
  return {
    id: row.id,
    type: row.type as ProjectCommand['type'],
    displayName: row.display_name,
    commandText: row.command_text,
    workingDirectory: row.working_directory,
    detectionSource: row.detection_source,
    isUserDefined: row.is_user_defined,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toProjectSummary(
  row: ProjectRow,
  technologies: Array<{ name: string; category: string }>,
): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    shortCode: row.short_code,
    status: row.status,
    priority: row.priority,
    tags: row.tags,
    location: toLocation(row),
    repository: toRepository(row),
    lastInspectedAt: row.last_inspected_at ? row.last_inspected_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    technologies: technologies.map((t) => ({ name: t.name, category: t.category as ProjectSummary['technologies'][number]['category'] })),
  };
}

export function toProjectDetail(
  row: ProjectRow,
  technologies: ProjectTechnologyRow[],
  rules: ProjectRuleRow[],
  commands: ProjectCommandRow[],
): ProjectDetail {
  return {
    id: row.id,
    name: row.name,
    shortCode: row.short_code,
    status: row.status,
    priority: row.priority,
    tags: row.tags,
    location: toLocation(row),
    repository: toRepository(row),
    lastInspectedAt: row.last_inspected_at ? row.last_inspected_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    description: row.description,
    purpose: row.purpose,
    productGoal: row.product_goal,
    createdBy: row.created_by,
    technologies: technologies.map(toProjectTechnology),
    rules: rules.map(toProjectRule),
    commands: commands.map(toProjectCommand),
  };
}
