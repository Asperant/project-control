/** Database row shapes for the projects feature — snake_case, as `pg` returns them. */

export type ProjectStatusRow = 'active' | 'paused' | 'completed' | 'archived';
export type ProjectPriorityRow = 'low' | 'medium' | 'high' | 'critical';
export type DefaultBranchConfidenceRow = 'known' | 'inferred' | 'unknown';

export type GitRemoteRow = { name: string; url: string };

export type ProjectRow = {
  id: string;
  name: string;
  short_code: string | null;
  description: string;
  purpose: string;
  product_goal: string;
  status: ProjectStatusRow;
  priority: ProjectPriorityRow;
  tags: string[];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  last_inspected_at: Date | null;

  location_input_path: string;
  location_canonical_path: string;
  location_allowed_root: string;
  location_accessible: boolean;
  location_checked_at: Date;

  repo_present: boolean;
  repo_top_level_path: string | null;
  repo_remotes: GitRemoteRow[];
  repo_normalized_identity: string | null;
  repo_active_branch: string | null;
  repo_default_branch: string | null;
  repo_default_branch_confidence: DefaultBranchConfidenceRow | null;
  repo_last_commit_hash: string | null;
  repo_last_commit_short_hash: string | null;
  repo_last_commit_at: Date | null;
  repo_last_commit_subject: string | null;
  repo_is_dirty: boolean | null;
  repo_modified_count: number | null;
  repo_untracked_count: number | null;
  repo_scanned_at: Date | null;
};

export type ProjectTechnologyRow = {
  id: string;
  project_id: string;
  name: string;
  category: string;
  version: string | null;
  detection_source: 'manifest' | 'user';
  evidence_path: string | null;
  is_user_defined: boolean;
  created_at: Date;
  updated_at: Date;
};

export type ProjectRuleRow = {
  id: string;
  project_id: string;
  category: string;
  text: string;
  enabled: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

export type ProjectCommandRow = {
  id: string;
  project_id: string;
  type: string;
  display_name: string;
  command_text: string;
  working_directory: string;
  detection_source: 'manifest' | 'user';
  is_user_defined: boolean;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type ProjectInspectionRow = {
  id: string;
  created_by: string;
  project_id: string | null;
  input_path: string;
  canonical_path: string;
  allowed_root: string;
  fingerprint: string;
  result: Record<string, unknown>;
  warnings: string[];
  scan_version: string;
  status: 'pending' | 'consumed' | 'expired' | 'rejected';
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};
