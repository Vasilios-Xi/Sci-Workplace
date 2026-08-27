import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, ChevronRight, FileSearch, FolderTree, Keyboard, Minus, PanelBottom,
  PanelLeft, RotateCw, Search, Square, TerminalSquare, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { AppMode } from '@openlab/protocol';
import { chatShellZhCN as shellCopy, hanaZhCN as copy } from '../i18n/zh-CN.js';
import { promptInApp } from './AppDialog.js';
import { KeyboardShortcutsDialog, ShellInfoDialog, type ShortcutGroup } from './ShellDialogs.js';

type OpenMenu = 'file' | 'edit' | 'view' | 'help' | null;
type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll';
type ViewCommand = 'zoom-in' | 'zoom-out' | 'reset-zoom' | 'toggle-fullscreen' | 'reload';
type InfoDialog = { title: string; lines: string[]; actionLabel?: string; onAction?(): void };

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { title: shellCopy.shortcuts.groups.general, items: [
    { label: shellCopy.shortcuts.openSettings, keys: ['Ctrl+,'] },
    { label: shellCopy.shortcuts.openFolder, keys: ['Ctrl+O'] },
    { label: shellCopy.titlebar.newChat, keys: ['Ctrl+N'] },
    { label: shellCopy.titlebar.newTemporaryChat, keys: ['Ctrl+Shift+N'] },
    { label: shellCopy.titlebar.keyboardShortcuts, keys: ['Ctrl+/'] },
  ] },
  { title: shellCopy.shortcuts.groups.edit, items: [
    { label: shellCopy.titlebar.undo, keys: ['Ctrl+Z'] }, { label: shellCopy.titlebar.redo, keys: ['Ctrl+Y'] },
    { label: shellCopy.titlebar.cut, keys: ['Ctrl+X'] }, { label: shellCopy.titlebar.copy, keys: ['Ctrl+C'] },
    { label: shellCopy.titlebar.paste, keys: ['Ctrl+V'] }, { label: shellCopy.titlebar.selectAll, keys: ['Ctrl+A'] },
  ] },
  { title: shellCopy.shortcuts.groups.view, items: [
    { label: shellCopy.titlebar.toggleSidebar, keys: ['Ctrl+B'] }, { label: shellCopy.titlebar.toggleBottomPanel, keys: ['Ctrl+J'] },
    { label: shellCopy.titlebar.openTerminal, keys: ['Ctrl+`'] }, { label: shellCopy.titlebar.toggleFileTree, keys: ['Ctrl+Shift+E'] },
    { label: shellCopy.titlebar.toggleReviewPanel, keys: ['Alt+Ctrl+B'] }, { label: shellCopy.titlebar.find, keys: ['Ctrl+F'] },
    { label: shellCopy.titlebar.previousChat, keys: ['Ctrl+Shift+['] }, { label: shellCopy.titlebar.nextChat, keys: ['Ctrl+Shift+]'] },
    { label: shellCopy.titlebar.back, keys: ['Ctrl+['] }, { label: shellCopy.titlebar.forward, keys: ['Ctrl+]'] },
    { label: shellCopy.titlebar.zoomIn, keys: ['Ctrl+Shift+='] }, { label: shellCopy.titlebar.zoomOut, keys: ['Ctrl+-'] },
    { label: shellCopy.titlebar.actualSize, keys: ['Ctrl+0'] }, { label: shellCopy.titlebar.toggleFullscreen, keys: ['F11'] },
  ] },
  { title: shellCopy.shortcuts.groups.conversation, items: [
    { label: shellCopy.shortcuts.sendMessage, keys: ['Enter'] }, { label: shellCopy.shortcuts.newLine, keys: ['Shift+Enter'] },
  ] },
];

export function Titlebar({
  projectName, projectFolderAvailable, mode, leftSidebarOpen, bottomPanelOpen, runtimeConnected,
  onToggleLeftSidebar, onToggleBottomPanel, onTogglePinnedSummary, onOpenFileTree, onOpenReviewPanel,
  onPreviousChat, onNextChat, onNewConversation, onNewTemporaryConversation, onOpenFolder, onSettings,
}: {
  projectName: string;
  projectFolderAvailable: boolean;
  mode: AppMode;
  leftSidebarOpen: boolean;
  bottomPanelOpen: boolean;
  runtimeConnected: boolean;
  onToggleLeftSidebar(): void;
  onToggleBottomPanel(): void;
  onTogglePinnedSummary(): void;
  onOpenFileTree(): void;
  onOpenReviewPanel(): void;
  onPreviousChat(): void;
  onNextChat(): void;
  onNewConversation(): void;
  onNewTemporaryConversation(): void;
  onOpenFolder(): void | Promise<void>;
  onSettings(): void;
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [infoDialog, setInfoDialog] = useState<InfoDialog>();
  const menusRef = useRef<HTMLDivElement>(null);
  const editTarget = useRef<HTMLElement | null>(null);

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

  const runViewCommand = (command: ViewCommand) => {
    if (window.openlab) window.openlab.view.command(command);
    else if (command === 'reload') window.location.reload();
    else if (command === 'toggle-fullscreen') void document.documentElement.requestFullscreen?.();
  };
  const findInPage = async () => {
    const query = await promptInApp(shellCopy.titlebar.findPrompt, '', { title: shellCopy.titlebar.find, confirmLabel: shellCopy.titlebar.findConfirm });
    if (query?.trim()) {
      if (window.openlab) window.openlab.view.findInPage(query.trim());
      else (window as unknown as { find(value: string): boolean }).find(query.trim());
    }
  };

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      const run = (action: () => void) => { event.preventDefault(); action(); };
      if (event.key === 'F11') return run(() => runViewCommand('toggle-fullscreen'));
      if (!primary) return;
      if (event.altKey && event.code === 'KeyB') return run(onOpenReviewPanel);
      if (event.shiftKey && event.code === 'KeyE') return run(onOpenFileTree);
      if (event.shiftKey && event.code === 'KeyN') return run(onNewTemporaryConversation);
      if (event.shiftKey && event.code === 'BracketLeft') return run(onPreviousChat);
      if (event.shiftKey && event.code === 'BracketRight') return run(onNextChat);
      if (event.shiftKey && event.code === 'Equal') return run(() => runViewCommand('zoom-in'));
      if (event.altKey) return;
      if (event.code === 'KeyB') return run(onToggleLeftSidebar);
      if (event.code === 'KeyN') return run(onNewConversation);
      if (event.code === 'KeyO') return run(() => { void onOpenFolder(); });
      if (event.code === 'KeyW') return run(() => window.openlab?.window.close());
      if (event.code === 'KeyJ') return run(onToggleBottomPanel);
      if (event.code === 'Backquote') return run(() => { void window.openlab?.view.openTerminal(); });
      if (event.code === 'KeyF') return run(() => { void findInPage(); });
      if (event.code === 'BracketLeft') return run(() => window.history.back());
      if (event.code === 'BracketRight') return run(() => window.history.forward());
      if (event.code === 'Minus') return run(() => runViewCommand('zoom-out'));
      if (event.code === 'Digit0') return run(() => runViewCommand('reset-zoom'));
      if (event.code === 'Slash') return run(() => setShortcutsOpen(true));
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  });

  const toggleMenu = (menu: Exclude<OpenMenu, null>) => setOpenMenu((current) => current === menu ? null : menu);
  const runMenuAction = (action: () => void | Promise<unknown>) => {
    setOpenMenu(null);
    void action();
  };
  const runEditCommand = (command: EditCommand) => runMenuAction(() => {
    editTarget.current?.focus({ preventScroll: true });
    if (window.openlab) window.openlab.edit.command(command);
    else document.execCommand(command);
  });
  const openInfo = (dialog: InfoDialog) => runMenuAction(() => setInfoDialog(dialog));

  return <><header className="titlebar">
    <div className="titlebar__desktop-left">
      {mode === 'chat' && <button className={`titlebar-panel-toggle titlebar-left-toggle ${leftSidebarOpen ? 'is-active' : ''}`} data-testid="titlebar-left-toggle" title={leftSidebarOpen ? copy.titlebar.hideConversations : copy.titlebar.showConversations} aria-label={leftSidebarOpen ? copy.titlebar.hideConversations : copy.titlebar.showConversations} aria-pressed={leftSidebarOpen} aria-controls="chat-sidebar" onClick={onToggleLeftSidebar}><PanelLeft size={17}/></button>}
      <button className="titlebar-history-button" aria-label={shellCopy.titlebar.back} title={shellCopy.titlebar.back} onClick={() => window.history.back()}><ArrowLeft size={17}/></button>
      <button className="titlebar-history-button" aria-label={shellCopy.titlebar.forward} title={shellCopy.titlebar.forward} onClick={() => window.history.forward()}><ArrowRight size={17}/></button>
      <div className="titlebar__menus" ref={menusRef}>
        <div className={`titlebar-menu ${openMenu === 'file' ? 'is-open' : ''}`}>
          <button data-testid="titlebar-file-menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === 'file'} onClick={() => toggleMenu('file')}>{shellCopy.titlebar.file}</button>
          {openMenu === 'file' && <div className="titlebar-app-menu titlebar-file-menu" role="menu">
            <button data-testid="file-new-window" role="menuitem" onClick={() => runMenuAction(() => window.openlab?.window.newWindow())}><span>{shellCopy.titlebar.newWindow}</span></button>
            <button data-testid="file-new-chat" role="menuitem" onClick={() => runMenuAction(onNewConversation)}><span>{shellCopy.titlebar.newChat}</span><kbd>Ctrl+N</kbd></button>
            <button data-testid="file-new-temporary-chat" role="menuitem" onClick={() => runMenuAction(onNewTemporaryConversation)}><span>{shellCopy.titlebar.newTemporaryChat}</span><kbd>Ctrl+Shift+N</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button data-testid="file-open-folder" role="menuitem" onClick={() => runMenuAction(onOpenFolder)}><span>{shellCopy.titlebar.openFolder}</span><kbd>Ctrl+O</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button data-testid="file-close-window" role="menuitem" onClick={() => runMenuAction(() => window.openlab?.window.close())}><span>{shellCopy.titlebar.closeWindow}</span><kbd>Ctrl+W</kbd></button>
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'edit' ? 'is-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={openMenu === 'edit'} onPointerDown={() => { editTarget.current = document.activeElement as HTMLElement | null; }} onClick={() => toggleMenu('edit')}>{shellCopy.titlebar.edit}</button>
          {openMenu === 'edit' && <div className="titlebar-app-menu titlebar-edit-menu" role="menu">
            <button role="menuitem" onClick={() => runEditCommand('undo')}><span>{shellCopy.titlebar.undo}</span><kbd>Ctrl+Z</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('redo')}><span>{shellCopy.titlebar.redo}</span><kbd>Ctrl+Y</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runEditCommand('cut')}><span>{shellCopy.titlebar.cut}</span><kbd>Ctrl+X</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('copy')}><span>{shellCopy.titlebar.copy}</span><kbd>Ctrl+C</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('paste')}><span>{shellCopy.titlebar.paste}</span><kbd>Ctrl+V</kbd></button>
            <button role="menuitem" onClick={() => runEditCommand('delete')}><span>{shellCopy.titlebar.delete}</span></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runEditCommand('selectAll')}><span>{shellCopy.titlebar.selectAll}</span><kbd>Ctrl+A</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(onSettings)}><span>{shellCopy.titlebar.settings}</span><kbd>Ctrl+,</kbd></button>
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'view' ? 'is-open' : ''}`}>
          <button data-testid="titlebar-view-menu-trigger" aria-haspopup="menu" aria-expanded={openMenu === 'view'} onClick={() => toggleMenu('view')}>{shellCopy.titlebar.view}</button>
          {openMenu === 'view' && <div className="titlebar-app-menu titlebar-view-menu" role="menu">
            <button role="menuitemcheckbox" aria-checked={leftSidebarOpen} onClick={() => runMenuAction(onToggleLeftSidebar)}><PanelLeft size={15}/><span>{shellCopy.titlebar.toggleSidebar}</span><kbd>Ctrl+B</kbd></button>
            <button role="menuitemcheckbox" aria-checked={bottomPanelOpen} onClick={() => runMenuAction(onToggleBottomPanel)}><PanelBottom size={15}/><span>{shellCopy.titlebar.toggleBottomPanel}</span><kbd>Ctrl+J</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(onTogglePinnedSummary)}><RotateCw size={15}/><span>{shellCopy.titlebar.togglePinnedSummary}</span></button>
            <button role="menuitem" onClick={() => runMenuAction(() => window.openlab?.view.openTerminal())}><TerminalSquare size={15}/><span>{shellCopy.titlebar.openTerminal}</span><kbd>Ctrl+`</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(onOpenFileTree)}><FolderTree size={15}/><span>{shellCopy.titlebar.toggleFileTree}</span><kbd>Ctrl+Shift+E</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(onOpenReviewPanel)}><FileSearch size={15}/><span>{shellCopy.titlebar.toggleReviewPanel}</span><kbd>Alt+Ctrl+B</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <div className="titlebar-submenu">
              <button role="menuitem" aria-haspopup="menu"><span>{shellCopy.titlebar.browser}</span><ChevronRight size={15}/></button>
              <div className="titlebar-app-menu titlebar-browser-menu" role="menu">
                <button role="menuitem" onClick={() => runMenuAction(() => window.history.back())}><span>{shellCopy.titlebar.back}</span></button>
                <button role="menuitem" onClick={() => runMenuAction(() => window.history.forward())}><span>{shellCopy.titlebar.forward}</span></button>
                <button role="menuitem" onClick={() => runMenuAction(() => runViewCommand('reload'))}><span>{shellCopy.titlebar.reload}</span><kbd>Ctrl+R</kbd></button>
              </div>
            </div>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(findInPage)}><Search size={15}/><span>{shellCopy.titlebar.find}</span><kbd>Ctrl+F</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(onPreviousChat)}><span>{shellCopy.titlebar.previousChat}</span><kbd>Ctrl+Shift+[</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(onNextChat)}><span>{shellCopy.titlebar.nextChat}</span><kbd>Ctrl+Shift+]</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(() => window.history.back())}><span>{shellCopy.titlebar.back}</span><kbd>Ctrl+[</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(() => window.history.forward())}><span>{shellCopy.titlebar.forward}</span><kbd>Ctrl+]</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(() => runViewCommand('zoom-in'))}><ZoomIn size={15}/><span>{shellCopy.titlebar.zoomIn}</span><kbd>Ctrl+Shift+=</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(() => runViewCommand('zoom-out'))}><ZoomOut size={15}/><span>{shellCopy.titlebar.zoomOut}</span><kbd>Ctrl+-</kbd></button>
            <button role="menuitem" onClick={() => runMenuAction(() => runViewCommand('reset-zoom'))}><span>{shellCopy.titlebar.actualSize}</span><kbd>Ctrl+0</kbd></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(() => runViewCommand('toggle-fullscreen'))}><span>{shellCopy.titlebar.toggleFullscreen}</span><kbd>F11</kbd></button>
          </div>}
        </div>
        <div className={`titlebar-menu ${openMenu === 'help' ? 'is-open' : ''}`}>
          <button aria-haspopup="menu" aria-expanded={openMenu === 'help'} onClick={() => toggleMenu('help')}>{shellCopy.titlebar.help}</button>
          {openMenu === 'help' && <div className="titlebar-app-menu titlebar-help-menu" role="menu">
            <button role="menuitem" onClick={() => runMenuAction(() => setShortcutsOpen(true))}><Keyboard size={15}/><span>{shellCopy.titlebar.keyboardShortcuts}</span><kbd>Ctrl+/</kbd></button>
            <button role="menuitem" onClick={() => openInfo({ title: shellCopy.titlebar.whatsNew, lines: [...shellCopy.help.newFeatureLines] })}><span>{shellCopy.titlebar.whatsNew}</span></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => openInfo({ title: shellCopy.titlebar.troubleshooting, lines: [...shellCopy.help.troubleshootingLines], actionLabel: shellCopy.help.exportDiagnostics, onAction: () => { void window.openlab?.exportDiagnostics(); } })}><span>{shellCopy.titlebar.troubleshooting}</span></button>
            <button role="menuitem" onClick={() => openInfo({ title: shellCopy.titlebar.systemStatus, lines: [shellCopy.help.runtimeStatus(runtimeConnected), shellCopy.help.projectStatus(projectFolderAvailable ? projectName : copy.timeline.noProject)] })}><span>{shellCopy.titlebar.systemStatus}</span></button>
            <button role="menuitem" onClick={() => runMenuAction(() => window.openlab?.openExternal('https://github.com/Vasilios-Xi/Sci-Workplace/issues/new'))}><span>{shellCopy.titlebar.feedback}</span></button>
            <span className="titlebar-app-menu__separator"/>
            <button role="menuitem" onClick={() => runMenuAction(() => window.openlab?.openExternal('https://github.com/Vasilios-Xi/Sci-Workplace/releases'))}><span>{shellCopy.titlebar.checkUpdates}</span></button>
            <button role="menuitem" onClick={() => openInfo({ title: shellCopy.titlebar.about, lines: [...shellCopy.help.aboutLines] })}><span>{shellCopy.titlebar.about}</span></button>
          </div>}
        </div>
      </div>
    </div>
    <div className="titlebar__drag-region" aria-hidden="true"/>
    <div className="titlebar__right">
      {window.openlab && <div className="window-controls"><button aria-label={copy.titlebar.minimize} onClick={() => window.openlab?.window.minimize()}><Minus size={17} strokeWidth={1.7}/></button><button aria-label={copy.titlebar.maximize} onClick={() => window.openlab?.window.maximize()}><Square size={14} strokeWidth={1.7}/></button><button className="window-controls__close" aria-label={copy.common.close} onClick={() => window.openlab?.window.close()}><X size={17} strokeWidth={1.7}/></button></div>}
    </div>
  </header>
  <KeyboardShortcutsDialog open={shortcutsOpen} groups={SHORTCUT_GROUPS} onClose={() => setShortcutsOpen(false)}/>
  <ShellInfoDialog open={Boolean(infoDialog)} title={infoDialog?.title ?? ''} lines={infoDialog?.lines ?? []} {...(infoDialog?.actionLabel ? { actionLabel: infoDialog.actionLabel } : {})} {...(infoDialog?.onAction ? { onAction: infoDialog.onAction } : {})} onClose={() => setInfoDialog(undefined)}/>
  </>;
}
