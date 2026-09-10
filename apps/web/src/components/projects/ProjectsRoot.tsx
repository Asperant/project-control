import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ProjectsList } from './ProjectsList';
import { NewProjectFlow } from './NewProjectFlow';
import { ProjectDetail } from './ProjectDetail';
import { RescanDiff } from './RescanDiff';

/**
 * Owns navigation between the projects screens via real routes — see
 * apps/web/src/App.tsx and main.tsx for the router this is mounted under.
 * `/projects/:id/*` delegates the tab suffix straight to ProjectDetail,
 * which derives its own active tab from the URL rather than local state.
 */
export function ProjectsRoot({ canWrite, onSessionExpired }: { canWrite: boolean; onSessionExpired: () => void }): React.JSX.Element {
  return (
    <Routes>
      <Route index element={<ProjectsListRouted canWrite={canWrite} onSessionExpired={onSessionExpired} />} />
      <Route path="new" element={<NewProjectFlowRouted onSessionExpired={onSessionExpired} />} />
      <Route path=":id/rescan" element={<RescanDiffRouted onSessionExpired={onSessionExpired} />} />
      <Route path=":id/*" element={<ProjectDetailRouted canWrite={canWrite} onSessionExpired={onSessionExpired} />} />
    </Routes>
  );
}

function ProjectsListRouted({ canWrite, onSessionExpired }: { canWrite: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <ProjectsList
      onOpenProject={(id) => navigate(`/projects/${id}`)}
      onNewProject={() => navigate('/projects/new')}
      onSessionExpired={onSessionExpired}
      canWrite={canWrite}
    />
  );
}

function NewProjectFlowRouted({ onSessionExpired }: { onSessionExpired: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <NewProjectFlow
      onCreated={(id) => navigate(`/projects/${id}`)}
      onCancel={() => navigate('/projects')}
      onSessionExpired={onSessionExpired}
    />
  );
}

function RescanDiffRouted({ onSessionExpired }: { onSessionExpired: () => void }): React.JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/projects" replace />;
  return (
    <RescanDiff
      projectId={id}
      onDone={() => navigate(`/projects/${id}`)}
      onSessionExpired={onSessionExpired}
    />
  );
}

function ProjectDetailRouted({ canWrite, onSessionExpired }: { canWrite: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const { id } = useParams();
  const navigate = useNavigate();
  if (!id) return <Navigate to="/projects" replace />;
  return (
    <ProjectDetail
      projectId={id}
      canWrite={canWrite}
      onBack={() => navigate('/projects')}
      onRescan={(projectId) => navigate(`/projects/${projectId}/rescan`)}
      onSessionExpired={onSessionExpired}
    />
  );
}
