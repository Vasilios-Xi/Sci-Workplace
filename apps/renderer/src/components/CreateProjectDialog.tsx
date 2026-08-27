import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react';
import { chatShellZhCN as copy } from '../i18n/zh-CN.js';

interface ProjectFolderSelection {
  path: string;
  name: string;
}

interface ExistingProjectFolders {
  name: string;
  sourceFolders: string[];
}

function folderName(path: string): string {
  return path.trim().replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean).at(-1) || path;
}

export function CreateProjectDialog({ open, initialProject, onClose, onCreate }: {
  open: boolean;
  initialProject?: ExistingProjectFolders;
  onClose(): void;
  onCreate(input: { sourceFolders: string[]; name: string }): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [folders, setFolders] = useState<ProjectFolderSelection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const editing = Boolean(initialProject);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setName(initialProject?.name ?? '');
    setFolders((initialProject?.sourceFolders ?? []).map((path) => ({ path, name: folderName(path) })));
    setBusy(false);
    setError(undefined);
    const frame = requestAnimationFrame(() => {
      if (initialProject) dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      else nameInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [initialProject, open]);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    onClose();
    requestAnimationFrame(() => restoreFocus.current?.focus());
  };

  const chooseFolder = async () => {
    setError(undefined);
    try {
      const selected = await window.openlab?.selectProjectFolder();
      if (!selected) return;
      setFolders((current) => current.some((item) => item.path.toLocaleLowerCase() === selected.path.toLocaleLowerCase()) ? current : [...current, selected]);
      setName((current) => current.trim() ? current : folders.length === 0 ? selected.name : current);
      requestAnimationFrame(() => nameInput.current?.focus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const create = async () => {
    if (folders.length === 0 || !name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ sourceFolders: folders.map((folder) => folder.path), name: name.trim() });
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div
    className="create-project-backdrop"
    data-testid="create-project-backdrop"
    onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
  >
    <form
      ref={dialog}
      className="create-project-dialog"
      data-testid="create-project-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-title"
      onSubmit={(event) => { event.preventDefault(); void create(); }}
    >
      <header>
        <h2 id="create-project-title">{editing ? copy.createProject.manageTitle(initialProject!.name) : copy.createProject.title}</h2>
        <button type="button" aria-label={copy.createProject.close} disabled={busy} onClick={close}><X size={20}/></button>
      </header>

      {!editing && <label className="create-project-name">
        <span><FolderOpen size={20}/></span>
        <input
          ref={nameInput}
          data-testid="create-project-name"
          aria-label={copy.createProject.projectName}
          maxLength={200}
          placeholder={copy.createProject.projectName}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>}

      <section className="create-project-source">
        <h3>{copy.createProject.sourceFolder}</h3>
        {folders.length === 0 ? <button
          type="button"
          className="create-project-folder-empty"
          data-testid="create-project-folder"
          disabled={busy}
          onClick={() => void chooseFolder()}
        ><FolderPlus size={27}/><strong>{copy.createProject.addFolder}</strong></button> : <div className="create-project-folder-list" data-testid="create-project-folder-list">
          {folders.map((folder, index) => <div key={folder.path} className="create-project-folder-row" title={folder.path}>
            <FolderOpen size={18}/><span><strong>{folder.name}</strong><small>{folder.path}</small></span>{(!editing || index > 0) && <button type="button" aria-label={copy.createProject.removeFolder(folder.name)} disabled={busy} onClick={() => setFolders((current) => current.filter((item) => item.path !== folder.path))}><X size={16}/></button>}{index === 0 && <em>{copy.createProject.primaryFolder}</em>}
          </div>)}
          <button type="button" className="create-project-add-folder" disabled={busy || folders.length >= 12} onClick={() => void chooseFolder()}><FolderPlus size={17}/><span>{copy.createProject.addAnotherFolder}</span></button>
        </div>}
      </section>

      {error && <p className="create-project-error" role="alert">{error}</p>}

      <footer>
        <button type="button" className="create-project-cancel" disabled={busy} onClick={close}>{copy.createProject.cancel}</button>
        <button type="submit" className="create-project-confirm" data-testid="create-project-confirm" disabled={folders.length === 0 || !name.trim() || busy}>{busy && <LoaderCircle className="spin" size={16}/>} {busy ? editing ? copy.createProject.saving : copy.createProject.creating : editing ? copy.createProject.saveFolders : copy.createProject.create}</button>
      </footer>
    </form>
  </div>;
}
