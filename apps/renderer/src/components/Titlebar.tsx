import { useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, FolderOpen, LayoutDashboard, MessageCircle, Minus, PanelLeft, PanelRight,
  Settings2, Square, UsersRound, X,
} from 'lucide-react';
import type { AppMode } from '@openlab/protocol';
import { agentV3ZhCN as v3Copy, chatShellZhCN as shellCopy, hanaZhCN as copy } from '../i18n/zh-CN.js';

type OpenMenu = 'file' | 'edit' | 'view' | 'help' | null;

export function Titlebar({
  projectName, projectFolderAvailable, connected, preview, mode, leftSidebarOpen, workspaceOpen, onModeChange, onToggleLeftSidebar,
  onToggleWorkspace, onChooseProject, onOpenProjectFolder, onSettings,
}: {
  projectName: string;
  projectFolderAvailable: boolean;
  connected: boolean;
  preview: boolean;
  mode: AppMode;
  leftSidebarOpen: boolean;
  workspaceOpen: boolean;
  onModeChange(mode: AppMode): void;
  onToggleLeftSidebar(): void;
  onToggleWorkspace(): void;
  onChooseProject(): void;
  onOpenProjectFolder(): void;
  onSettings(): void;
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const menusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!menusRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [openMenu]);

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => setOpenMenu((current) => current === menu ? null : menu);
  const runMenuAction = (action: () => void) => {
    setOpenMenu(null);
    action();
  };
  const runEditCommand = (command: 'undo' | 'redo' | 'copy' | 'selectAll') => runMenuAction(() => {
    document.execCommand(command);
  });
  const switchMode = (nextMode: AppMode) => runMenuAction(() => onModeChange(nextMode));

  return <header className="titlebar">
    <div className="titlebar__desktop-left">
      {mode === 'chat' && <button className={`titlebar-panel-toggle titlebar-left-toggle ${leftSidebarOpen ? 'is-active' : ''}`} data-testid="titlebar-left-toggle" title={leftSidebarOpen ? copy.titlebar.hideConversations : copy.titlebar.showConversations} aria-label={leftSidebarOpen ? copy.titlebar.hideConversations : copy.titlebar.showConversations} aria-pressed={leftSidebarOpen} aria-controls="chat-sidebar" onClick={onToggleLeftSidebar}><PanelLeft size={17}/></button>}
      <button className="titlebar-history-button" aria-label={shellCopy.titlebar.back} title={shellCopy.titlebar.back} onClick={() => window.history.back()}><ArrowLeft size={17}/></button>
      <button className="titlebar-history-button" aria-label={shellCopy.titlebar.forward} title={shellCopy.titlebar.forward} onClick={() => window.history.forward()}><ArrowRight size={17}/></button>
      <div className="titlebar__menus" ref={menusRef}>
        <div className={`titlebar-menu ${openMenu === 'file' ? 'is-open' : ''}`}>
          <button data-testid="titlebar-file-menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === 'file'} onClick={() => toggleMenu('file')}>{shellCopy.titlebar.file}</button>
          {openMenu === 'file' && <div className="titlebar-app-menu" role="menu">
            <div className="titlebar-app-menu__context"><strong>{projectName}</strong><small>{shellCopy.titlebar.currentProject}</small></div>
            {projectFolderAvailable && <button role="menuitem" onClick={() => runMenuAction(onOpenProjectFolder)}><FolderOpen size={15}/><span>{shellCopy.titlebar.openProjectFolder}</span><kbd>Ctrl+P</kbd></button>}
            <button role="menuitem" onClick={() => runMenuAction(onChooseProject)}><PanelLeft size={15}/><span>{shellCopy.titlebar.switchProject}</span></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(onSettings)}><Settings2 size={15}/><span>{shellCopy.titlebar.settings}</span><kbd>Ctrl+,</kbd></button>
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'edit' ? 'is-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={openMenu === 'edit'} onClick={() => toggleMenu('edit')}>{shellCopy.titlebar.edit}</button>
          {openMenu === 'edit' && <div className="titlebar-app-menu" role="menu">
            <button role="menuitem" onClick={() => runEditCommand('undo')}><span>{shellCopy.titlebar.undo}</span><kbd>Ctrl+Z</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('redo')}><span>{shellCopy.titlebar.redo}</span><kbd>Ctrl+Y</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runEditCommand('copy')}><span>{shellCopy.titlebar.copy}</span><kbd>Ctrl+C</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('selectAll')}><span>{shellCopy.titlebar.selectAll}</span><kbd>Ctrl+A</kbd></button>
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'view' ? 'is-open' : ''}`}>
          <button data-testid="titlebar-view-menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === 'view'} onClick={() => toggleMenu('view')}>{shellCopy.titlebar.view}</button>
          {openMenu === 'view' && <div className="titlebar-app-menu titlebar-view-menu" role="menu">
            <nav className="titlebar-mode-switch" aria-label={shellCopy.titlebar.appViews}>
              <button role="menuitemradio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'is-active' : ''} onClick={() => switchMode('chat')}><MessageCircle size={15}/><span>{v3Copy.titlebar.chat}</span></button>
              <button role="menuitemradio" aria-checked={mode === 'worktable'} className={mode === 'worktable' ? 'is-active' : ''} onClick={() => switchMode('worktable')}><LayoutDashboard size={15}/><span>{v3Copy.titlebar.worktable}</span></button>
              <button role="menuitemradio" aria-checked={mode === 'channels'} className={mode === 'channels' ? 'is-active' : ''} onClick={() => switchMode('channels')}><UsersRound size={15}/><span>{v3Copy.titlebar.channels}</span></button>
            </nav>
            {mode === 'chat' && <><span className="titlebar-app-menu__separator"/><button role="menuitemcheckbox" aria-checked={leftSidebarOpen} onClick={() => runMenuAction(onToggleLeftSidebar)}><PanelLeft size={15}/><span>{shellCopy.titlebar.conversations}</span><kbd>{leftSidebarOpen ? shellCopy.titlebar.expanded : shellCopy.titlebar.collapsed}</kbd></button><button role="menuitemcheckbox" aria-checked={workspaceOpen} onClick={() => runMenuAction(onToggleWorkspace)}><PanelRight size={15}/><span>{shellCopy.titlebar.workspace}</span><kbd>{workspaceOpen ? shellCopy.titlebar.expanded : shellCopy.titlebar.collapsed}</kbd></button></>}
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'help' ? 'is-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={openMenu === 'help'} onClick={() => toggleMenu('help')}>{shellCopy.titlebar.help}</button>
          {openMenu === 'help' && <div className="titlebar-app-menu titlebar-help-menu" role="menu">
            <div className="titlebar-app-menu__context"><strong>Sci Workplace</strong><small>{shellCopy.titlebar.description}</small></div>
            <div className={`titlebar-runtime-row ${connected ? 'is-online' : ''}`}><Activity size={14}/><span>{preview ? copy.titlebar.previewMode : connected ? copy.titlebar.connected : copy.titlebar.disconnected}</span></div>
          </div>}
        </div>
      </div>
    </div>
    <div className="titlebar__drag-region" aria-hidden="true"/>
    <div className="titlebar__right">
      {window.openlab && <div className="window-controls"><button aria-label={copy.titlebar.minimize} onClick={() => window.openlab?.window.minimize()}><Minus size={17} strokeWidth={1.7}/></button><button aria-label={copy.titlebar.maximize} onClick={() => window.openlab?.window.maximize()}><Square size={14} strokeWidth={1.7}/></button><button className="window-controls__close" aria-label={copy.common.close} onClick={() => window.openlab?.window.close()}><X size={17} strokeWidth={1.7}/></button></div>}
    </div>
  </header>;
}
