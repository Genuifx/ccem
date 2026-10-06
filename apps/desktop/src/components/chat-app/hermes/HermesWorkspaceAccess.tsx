import { useState } from 'react';
import { FolderOpen } from '@/lib/lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useLocale } from '@/locales';
import type { HermesRoute, HermesRunAction } from '@/lib/hermes-ipc';
import { workspaceName } from './HermesVisuals';

export type WorkspaceAccess = { workspaces: string[]; allowInput: boolean; notifications: boolean };
export function effectiveAccess(value: WorkspaceAccess): WorkspaceAccess {
  return { ...value, allowInput: value.workspaces.length > 0 && value.allowInput, notifications: value.workspaces.length > 0 && value.notifications };
}

export function WorkspaceAccessFields({ id, workspaces, value, onChange, disabled }: {
  id: string; workspaces: string[]; value: WorkspaceAccess; onChange: (value: WorkspaceAccess) => void; disabled: boolean;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const visible = workspaces.filter((workspace) => workspace.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <fieldset disabled={disabled} className="hermes-workspaces">
    <legend>{t('hermes.authorizedWorkspaces')}</legend>
    {workspaces.length === 0 ? <p className="hermes-caption">{t('hermes.noWorkspaces')}</p> : <>
      <Input id={`hermes-workspace-search-${id}`} type="search" value={query} placeholder={t('hermes.searchWorkspaces')}
        aria-label={t('hermes.searchWorkspaces')} onChange={(event) => setQuery(event.target.value)} />
      <p className="hermes-caption" aria-live="polite">{t('hermes.selectedWorkspaces', { count: value.workspaces.length })}</p>
    </>}
    <div className="hermes-workspace-list">{visible.map((workspace) => <label key={workspace} className="hermes-workspace-option">
      <FolderOpen aria-hidden="true" /><span><strong>{workspaceName(workspace)}</strong><small>{workspace}</small></span>
      <Switch aria-label={workspace} checked={value.workspaces.includes(workspace)} disabled={disabled}
        onCheckedChange={(checked) => onChange({ ...value, workspaces: checked ? [...new Set([...value.workspaces, workspace])] : value.workspaces.filter((item) => item !== workspace) })} />
    </label>)}</div>
    {workspaces.length > 0 && visible.length === 0 && <p className="hermes-caption">{t('hermes.noMatchingWorkspaces')}</p>}
    {value.workspaces.length === 0 && <p className="hermes-caption">{t('hermes.noWorkspaceAccessHint')}</p>}
    <label className="hermes-permission-option"><span>{t('hermes.allowInput')}</span><Switch checked={value.workspaces.length > 0 && value.allowInput}
      onCheckedChange={(allowInput) => onChange({ ...value, allowInput })} disabled={disabled || value.workspaces.length === 0} aria-label={t('hermes.allowInput')} /></label>
    <label className="hermes-permission-option"><span>{t('hermes.notifications')}</span><Switch checked={value.workspaces.length > 0 && value.notifications}
      onCheckedChange={(notifications) => onChange({ ...value, notifications })} disabled={disabled || value.workspaces.length === 0} aria-label={t('hermes.notifications')} /></label>
  </fieldset>;
}

export function RouteAccessEditor({ route, workspaces, disabled, run, onClose }: {
  route: HermesRoute; workspaces: string[]; disabled: boolean; run: HermesRunAction; onClose: () => void;
}) {
  const { t } = useLocale();
  const [value, setValue] = useState<WorkspaceAccess>({ workspaces: route.workspaces, allowInput: route.allowInput,
    notifications: route.workspaces.length ? route.notifications : true });
  const effective = effectiveAccess(value);
  const changed = JSON.stringify([...effective.workspaces].sort()) !== JSON.stringify([...route.workspaces].sort())
    || effective.allowInput !== route.allowInput || effective.notifications !== route.notifications;
  // Existing grants remain visible even if that workspace was removed from the desktop list.
  const available = [...new Set([...route.workspaces, ...workspaces])];
  return <form tabIndex={-1} aria-label={t('hermes.manageWorkspaceAccess')} className="hermes-route-editor" data-hermes-route-editor={route.id} onSubmit={(event) => {
    event.preventDefault();
    if (disabled || !changed) return;
    void run('updateRoute', { accountRef: route.source.accountRef, id: route.id, generation: route.generation, ...effective })
      .then((result) => { if (result) onClose(); });
  }}>
    <WorkspaceAccessFields id={route.id} workspaces={available} value={value} onChange={setValue} disabled={disabled} />
    <div className="flex gap-2"><Button type="submit" size="sm" disabled={disabled || !changed}>{t('hermes.saveWorkspaceAccess')}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onClose}>{t('hermes.cancel')}</Button></div>
  </form>;
}
