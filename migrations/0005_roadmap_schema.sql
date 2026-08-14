-- Manual roadmap data attached to registered projects. No AI or runner path is involved.
CREATE TABLE IF NOT EXISTS roadmap_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects (id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','blocked','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    target_date DATE,
    blocked_reason TEXT CONSTRAINT roadmap_milestones_blocked_reason_length CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 2000),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    created_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT roadmap_milestones_blocked_reason_check CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
    CONSTRAINT roadmap_milestones_position_key UNIQUE (project_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS roadmap_milestones_project_idx ON roadmap_milestones (project_id, sort_order);
CREATE INDEX IF NOT EXISTS roadmap_milestones_status_idx ON roadmap_milestones (project_id, status);
CREATE INDEX IF NOT EXISTS roadmap_milestones_archived_idx ON roadmap_milestones (project_id, archived_at) WHERE archived_at IS NOT NULL;
DROP TRIGGER IF EXISTS roadmap_milestones_set_updated_at ON roadmap_milestones;
CREATE TRIGGER roadmap_milestones_set_updated_at BEFORE UPDATE ON roadmap_milestones
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS roadmap_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    milestone_id UUID NOT NULL REFERENCES roadmap_milestones (id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','blocked','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    blocked_reason TEXT CONSTRAINT roadmap_tasks_blocked_reason_length CHECK (blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 2000),
    next_action TEXT NOT NULL DEFAULT '' CHECK (length(next_action) <= 4000),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT roadmap_tasks_blocked_reason_check CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
    CONSTRAINT roadmap_tasks_position_key UNIQUE (milestone_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS roadmap_tasks_milestone_idx ON roadmap_tasks (milestone_id, sort_order);
CREATE INDEX IF NOT EXISTS roadmap_tasks_status_idx ON roadmap_tasks (milestone_id, status);
CREATE INDEX IF NOT EXISTS roadmap_tasks_cancelled_idx ON roadmap_tasks (milestone_id, cancelled_at) WHERE cancelled_at IS NOT NULL;
DROP TRIGGER IF EXISTS roadmap_tasks_set_updated_at ON roadmap_tasks;
CREATE TRIGGER roadmap_tasks_set_updated_at BEFORE UPDATE ON roadmap_tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES roadmap_tasks (id),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
    is_completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_acceptance_completion_check CHECK (is_completed = (completed_at IS NOT NULL)),
    CONSTRAINT task_acceptance_position_key UNIQUE (task_id, sort_order) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS task_acceptance_task_idx ON task_acceptance_criteria (task_id, sort_order);
DROP TRIGGER IF EXISTS task_acceptance_set_updated_at ON task_acceptance_criteria;
CREATE TRIGGER task_acceptance_set_updated_at BEFORE UPDATE ON task_acceptance_criteria
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id UUID NOT NULL REFERENCES roadmap_tasks (id),
    depends_on_task_id UUID NOT NULL REFERENCES roadmap_tasks (id),
    created_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, depends_on_task_id),
    CONSTRAINT task_dependencies_not_self CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS task_dependencies_target_idx ON task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES roadmap_tasks (id),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    created_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS task_notes_task_idx ON task_notes (task_id, created_at) WHERE deleted_at IS NULL;
DROP TRIGGER IF EXISTS task_notes_set_updated_at ON task_notes;
CREATE TRIGGER task_notes_set_updated_at BEFORE UPDATE ON task_notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE roadmap_milestones IS 'Manual roadmap milestones; rows are archived, cancelled, or reactivated, never deleted.';
COMMENT ON TABLE roadmap_tasks IS 'Manual roadmap tasks; rows are cancelled or reopened, never deleted.';
COMMENT ON COLUMN roadmap_tasks.next_action IS 'Operator-authored structured next action; never AI generated.';
