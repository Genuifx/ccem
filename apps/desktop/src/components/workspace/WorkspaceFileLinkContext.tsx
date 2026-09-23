import { createContext, useContext } from 'react';

export interface WorkspaceFileLinkTarget {
  openFile: (path: string) => void;
  /** Relative document links resolve beside the previewed document. */
  documentPath?: string;
  workingDir?: string;
}

export const WorkspaceFileLinkContext = createContext<WorkspaceFileLinkTarget | null>(null);
export const useWorkspaceFileLinks = () => useContext(WorkspaceFileLinkContext);
