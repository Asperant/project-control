import { useState } from 'react';
import { ProjectsList } from './ProjectsList';
import { NewProjectFlow } from './NewProjectFlow';
import { ProjectDetail } from './ProjectDetail';
import { RescanDiff } from './RescanDiff';

type View =
  | { screen: 'list' }
  | { screen: 'new' }
  | { screen: 'detail'; id: string }
  | { screen: 'rescan'; id: string };

/**
 * Owns navigation between the projects screens. No router library — the rest
 * of this panel is five screens switched by local state, and a project's
 * sub-navigation is the same pattern at a smaller scale.
 */
export function ProjectsRoot({ canWrite, onSessionExpired }: { canWrite: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const [view, setView] = useState<View>({ screen: 'list' });

  switch (view.screen) {
    case 'list':
      return (
        <ProjectsList
          onOpenProject={(id) => setView({ screen: 'detail', id })}
          onNewProject={() => setView({ screen: 'new' })}
          onSessionExpired={onSessionExpired}
          canWrite={canWrite}
        />
      );

    case 'new':
      return (
        <NewProjectFlow
          onCreated={(id) => setView({ screen: 'detail', id })}
          onCancel={() => setView({ screen: 'list' })}
          onSessionExpired={onSessionExpired}
        />
      );

    case 'detail':
      return (
        <ProjectDetail
          projectId={view.id}
          canWrite={canWrite}
          onBack={() => setView({ screen: 'list' })}
          onRescan={(id) => setView({ screen: 'rescan', id })}
          onSessionExpired={onSessionExpired}
        />
      );

    case 'rescan':
      return (
        <RescanDiff
          projectId={view.id}
          onDone={() => setView({ screen: 'detail', id: view.id })}
          onSessionExpired={onSessionExpired}
        />
      );
  }
}
