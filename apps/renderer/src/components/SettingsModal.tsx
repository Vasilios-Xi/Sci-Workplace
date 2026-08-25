import { hanaZhCN, t, tf, zhCN } from "./../i18n/zh-CN.js";
import { useState } from 'react';
import { Bot, Braces, ChevronRight, Database, Download, Eye, EyeOff, HardDrive, Info, KeyRound, Languages, Network, Palette, Power, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, X } from 'lucide-react';
import type { AgentCardExport, AgentDefinition, AgentDefinitionUpdate, AgentMemoryItem, AgentToolPolicy, BootstrapSnapshot, HarnessSettings, McpServerConfig, ModelProviderConfig, ModelProviderId, PermissionRule, ReasoningEffort, SecurityApprovalPolicy, SecurityPermissionCategory } from '@openlab/protocol';
import { ProviderSettings } from './ProviderSettings.js';
import { PrimaryAgentSettings } from './PrimaryAgentSettings.js';
import { InterfaceSettings } from './InterfaceSettings.js';
import { confirmInApp } from './AppDialog.js';
type SettingsPage = 'providers' | 'agents' | 'interface' | 'context' | 'skills' | 'mcp' | 'security' | 'data' | 'about';
const pages: Array<{
    id: SettingsPage;
    label: string;
    icon: typeof Bot;
}> = [
    { id: 'providers', label: zhCN.settingsPages.deepseek, icon: Sparkles },
    { id: 'agents', label: zhCN.settingsPages.agents, icon: Bot },
    { id: 'interface', label: zhCN.settingsPages.interface, icon: Palette },
    { id: 'context', label: zhCN.settingsPages.context, icon: SlidersHorizontal },
    { id: 'skills', label: zhCN.settingsPages.skills, icon: Braces },
    { id: 'mcp', label: zhCN.settingsPages.mcp, icon: Network },
    { id: 'security', label: zhCN.settingsPages.security, icon: ShieldCheck },
    { id: 'data', label: zhCN.settingsPages.data, icon: HardDrive },
    { id: 'about', label: zhCN.settingsPages.about, icon: Info },
];
interface SettingsProps {
    open: boolean;
    snapshot: BootstrapSnapshot;
    onClose(): void;
    onRefresh(): Promise<void>;
    onInstallExtension(kind: 'skill', scope?: 'user' | 'project'): Promise<void>;
    onApproveSkill(id: string, sha256: string): Promise<void>;
    onConfigureMcp(config: McpServerConfig): Promise<void>;
    onMcpAction(config: McpServerConfig, action: 'enable' | 'disable' | 'remove'): Promise<void>;
    onUpdateSettings(patch: Partial<HarnessSettings>): Promise<void>;
    onCreateAgent(input: { name: string; avatar?: AgentDefinition['avatar']; templateId?: AgentDefinition['templateId']; identity?: string; instructions?: string; model?: string; reasoningEffort?: ReasoningEffort }): Promise<AgentDefinition | undefined>;
    onUpdateAgent(id: string, patch: AgentDefinitionUpdate): Promise<AgentDefinition | undefined>;
    onArchiveAgent(id: string, restore?: boolean): Promise<void>;
    onImportAgent(card: AgentCardExport): Promise<AgentDefinition | undefined>;
    onExportAgent(id: string): Promise<AgentCardExport | undefined>;
    onSetAgentToolPolicy(id: string, policy: AgentToolPolicy): Promise<void>;
    onSetProjectAgentCapabilities(id: string, capabilityIds: string[]): Promise<void>;
    onListMemories(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope']; query?: string }): Promise<AgentMemoryItem[]>;
    onCreateMemory(agentId: string, scope: AgentMemoryItem['scope'], content: string): Promise<void>;
    onUpdateMemory(id: string, patch: { content?: string; confidence?: number }): Promise<void>;
    onDeleteMemory(id: string): Promise<void>;
    onClearMemories(agentId: string, options?: { kind?: AgentMemoryItem['kind']; scope?: AgentMemoryItem['scope'] }): Promise<void>;
    onConfigureProvider(id: ModelProviderId, patch: Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>, secret?: string): Promise<void>;
    onRefreshProvider(id: ModelProviderId): Promise<void>;
    onProviderOAuth(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<unknown>;
    onProviderLogout(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<void>;
    onExportDiagnostics(): Promise<void>;
    onBackupData(): Promise<void>;
}
function SettingRow({ title, description, children }: {
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

const DEFAULT_SECURITY_POLICY: SecurityApprovalPolicy = {
    schemaVersion: 1,
    projectRead: 'allow',
    workspaceWrite: 'ask',
    terminalExecution: 'ask',
    deletion: 'ask',
    networkAccess: 'ask',
    outsideWorkspace: 'ask',
    extensionInstall: 'ask',
    externalTools: 'ask',
};

const SECURITY_CATEGORIES: SecurityPermissionCategory[] = [
    'projectRead',
    'workspaceWrite',
    'terminalExecution',
    'deletion',
    'networkAccess',
    'outsideWorkspace',
    'extensionInstall',
    'externalTools',
];

const HIGH_RISK_SECURITY_CATEGORIES = new Set<SecurityPermissionCategory>([
    'terminalExecution',
    'deletion',
    'networkAccess',
    'outsideWorkspace',
    'extensionInstall',
    'externalTools',
]);

function SecuritySettings({ settings, onUpdate }: {
    settings: HarnessSettings;
    onUpdate(patch: Partial<HarnessSettings>): Promise<void>;
}) {
    const [saving, setSaving] = useState<SecurityPermissionCategory>();
    const policy = settings.securityPolicy;
    const updateRule = async (category: SecurityPermissionCategory, rule: PermissionRule) => {
        if (rule === policy[category])
            return;
        if (rule === 'allow' && HIGH_RISK_SECURITY_CATEGORIES.has(category)
            && !await confirmInApp(hanaZhCN.securityPolicy.allowWarning, { title: hanaZhCN.securityPolicy.title, confirmLabel: hanaZhCN.securityPolicy.rules.allow }))
            return;
        setSaving(category);
        try {
            await onUpdate({ securityPolicy: { ...policy, [category]: rule } });
        }
        finally {
            setSaving(undefined);
        }
    };
    const reset = async () => {
        if (!await confirmInApp(hanaZhCN.securityPolicy.resetConfirm, { title: hanaZhCN.securityPolicy.reset, confirmLabel: hanaZhCN.securityPolicy.reset, tone: 'danger' }))
            return;
        setSaving('projectRead');
        try {
            await onUpdate({ securityPolicy: { ...DEFAULT_SECURITY_POLICY } });
        }
        finally {
            setSaving(undefined);
        }
    };
    return <>
      <div className="settings-heading"><span className="settings-heading__icon red"><ShieldCheck size={20}/></span><div><h2>{hanaZhCN.securityPolicy.title}</h2><p>{hanaZhCN.securityPolicy.subtitle}</p></div></div>
      <div className="security-policy-note"><ShieldCheck size={15}/><div><strong>{hanaZhCN.securityPolicy.noteTitle}</strong><span>{hanaZhCN.securityPolicy.note}</span></div></div>
      <section className="settings-card security-policy-card">
        {SECURITY_CATEGORIES.map((category) => <SettingRow key={category} title={hanaZhCN.securityPolicy.categories[category].title} description={hanaZhCN.securityPolicy.categories[category].description}>
          <select
            data-testid={`security-policy-${category}`}
            className={`security-rule is-${policy[category]}`}
            aria-label={hanaZhCN.securityPolicy.categories[category].title}
            value={policy[category]}
            disabled={saving !== undefined}
            onChange={(event) => void updateRule(category, event.target.value as PermissionRule)}
          >
            <option value="allow">{hanaZhCN.securityPolicy.rules.allow}</option>
            <option value="ask">{hanaZhCN.securityPolicy.rules.ask}</option>
            <option value="deny">{hanaZhCN.securityPolicy.rules.deny}</option>
          </select>
        </SettingRow>)}
        <SettingRow title={hanaZhCN.securityPolicy.isolationTitle} description={hanaZhCN.securityPolicy.isolationDescription}><span className="setting-value">{hanaZhCN.securityPolicy.isolationValue}</span></SettingRow>
      </section>
      <div className="security-policy-footer"><span>{saving ? hanaZhCN.securityPolicy.saving : hanaZhCN.securityPolicy.saved}</span><button data-testid="security-policy-reset" className="button secondary" disabled={saving !== undefined} onClick={() => void reset()}>{hanaZhCN.securityPolicy.reset}</button></div>
    </>;
}
export function SettingsModal({ open, snapshot, onClose, onInstallExtension, onApproveSkill, onConfigureMcp, onMcpAction, onUpdateSettings, onCreateAgent, onUpdateAgent, onArchiveAgent, onImportAgent, onExportAgent, onSetAgentToolPolicy, onSetProjectAgentCapabilities, onListMemories, onCreateMemory, onUpdateMemory, onDeleteMemory, onClearMemories, onConfigureProvider, onRefreshProvider, onProviderOAuth, onProviderLogout, onExportDiagnostics, onBackupData }: SettingsProps) {
    const [page, setPage] = useState<SettingsPage>('providers');
    const [showMcpForm, setShowMcpForm] = useState(false);
    const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio');
    const [mcpId, setMcpId] = useState('');
    const [mcpName, setMcpName] = useState('');
    const [mcpTarget, setMcpTarget] = useState('');
    const [mcpCredentialName, setMcpCredentialName] = useState('');
    const [mcpCredentialValue, setMcpCredentialValue] = useState('');
    const [mcpSaving, setMcpSaving] = useState(false);
    if (!open)
        return null;
    const saveMcp = async () => {
        if (!mcpId || !mcpName || !mcpTarget)
            return;
        setMcpSaving(true);
        try {
            let credentialId: string | undefined;
            if (mcpCredentialName.trim() && mcpCredentialValue && window.openlab)
                credentialId = await window.openlab.saveCredential(mcpCredentialValue);
            const config: McpServerConfig = mcpTransport === 'stdio'
                ? {
                    id: mcpId, name: mcpName, transport: 'stdio', command: mcpTarget.split(/\s+/u)[0] ?? mcpTarget,
                    args: mcpTarget.split(/\s+/u).slice(1), envCredentialRefs: credentialId ? { [mcpCredentialName.trim()]: credentialId } : {}, enabled: true,
                }
                : {
                    id: mcpId, name: mcpName, transport: 'http', url: mcpTarget,
                    headerCredentialRefs: credentialId ? { [mcpCredentialName.trim()]: credentialId } : {}, enabled: true,
                };
            await onConfigureMcp(config);
            setShowMcpForm(false);
            setMcpCredentialValue('');
        }
        finally {
            setMcpSaving(false);
        }
    };
    return (<div className="modal-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <div className="settings-modal" data-testid="settings-modal" role="dialog" aria-modal="true" aria-label={t("copy073")}>
        <header className="settings-title"><div><strong>{t("copy074")}</strong><small>{t("copy075")}</small></div><button data-testid="settings-close" onClick={onClose}><X size={17}/></button></header>
        <aside className="settings-nav">{pages.map((item) => <button key={item.id} data-testid={`settings-page-${item.id}`} className={page === item.id ? 'is-active' : ''} onClick={() => setPage(item.id)}><item.icon size={15}/>{item.label}<ChevronRight size={13}/></button>)}</aside>
        <main className="settings-content">
          {page === 'providers' && <ProviderSettings providers={snapshot.providers} settings={snapshot.settings} onConfigure={onConfigureProvider} onRefresh={onRefreshProvider} onOAuthStart={onProviderOAuth} onOAuthLogout={onProviderLogout} onUpdateSettings={onUpdateSettings}/>}
          {page === 'agents' && <div data-testid="settings-agent-page"><PrimaryAgentSettings snapshot={snapshot} onCreate={onCreateAgent} onUpdate={onUpdateAgent} onArchive={onArchiveAgent} onImport={onImportAgent} onExport={onExportAgent} onSetToolPolicy={onSetAgentToolPolicy} onSetProjectCapabilities={onSetProjectAgentCapabilities} onListMemories={onListMemories} onCreateMemory={onCreateMemory} onUpdateMemory={onUpdateMemory} onDeleteMemory={onDeleteMemory} onClearMemories={onClearMemories} onUpdateSettings={onUpdateSettings}/></div>}
          {page === 'interface' && <InterfaceSettings/>}
          {page === 'context' && <><div className="settings-heading"><span className="settings-heading__icon amber"><SlidersHorizontal size={20}/></span><div><h2>{t("copy105")}</h2><p>{t("copy106")}</p></div></div><section className="settings-card"><SettingRow title={t("copy107")} description={t("copy108")}><select value={snapshot.settings.defaultAgentContextBudget} onChange={(event) => void onUpdateSettings({ defaultAgentContextBudget: Number(event.target.value) })}><option value={128000}>{t("copy109")}</option><option value={256000}>{t("copy110")}</option><option value={512000}>{t("copy111")}</option><option value={1000000}>{t("copy112")}</option></select></SettingRow><SettingRow title={t("copy113")} description={t("copy114")}><select value={snapshot.settings.delegatedAgentContextBudget} onChange={(event) => void onUpdateSettings({ delegatedAgentContextBudget: Number(event.target.value) })}><option value={96000}>{t("copy115")}</option><option value={128000}>{t("copy109")}</option><option value={256000}>{t("copy110")}</option><option value={512000}>{t("copy111")}</option></select></SettingRow><SettingRow title={t("copy116")} description={t("copy117")}><span className="setting-value">80%</span></SettingRow><SettingRow title={t("copy118")} description={t("copy119")}><span className="setting-value">{t("copy120")}</span></SettingRow></section></>}
          {page === 'skills' && <><div className="settings-heading"><span className="settings-heading__icon green"><Braces size={20}/></span><div><h2>{t("copy121")}</h2><p>{t("copy122")}</p></div></div><section className="settings-card extension-list">{snapshot.skills.length ? snapshot.skills.map((skill) => <div key={skill.id}><span className="extension-icon"><Braces size={15}/></span><div><strong>{skill.name}</strong><small>{skill.description}</small></div><em>{zhCN.scopes[skill.scope]}</em>{skill.approvalRequired && skill.sha256 && <button className="button secondary" onClick={() => void onApproveSkill(skill.id, skill.sha256!)}><ShieldCheck size={13}/>{hanaZhCN.workspace.approve}</button>}</div>) : <div className="extension-empty"><Braces size={24}/><strong>{t("copy123")}</strong><span>{t("copy124")}</span></div>}<div className="settings-extension-actions"><button className="button secondary" onClick={() => void onInstallExtension('skill', 'user')}><Download size={14}/>{hanaZhCN.composer.importUserSkill}</button><button className="button secondary" onClick={() => void onInstallExtension('skill', 'project')}><Download size={14}/>{hanaZhCN.composer.importWorkspaceSkill}</button></div></section></>}
          {page === 'mcp' && <>
            <div className="settings-heading"><span className="settings-heading__icon cyan"><Network size={20}/></span><div><h2>{t("copy126")}</h2><p>{t("copy127")}</p></div></div>
            <section className="settings-card extension-list">
              {snapshot.mcpServers.length > 0 && snapshot.mcpServers.map((server) => <div key={server.config.id}><span className="extension-icon"><Network size={15}/></span><div><strong>{server.config.name}</strong><small>{zhCN.mcpTransports[server.config.transport]} · {server.error ?? server.config.id}</small></div><em>{zhCN.mcpStatuses[server.status]}</em><span className="plugin-actions"><button title={server.config.enabled ? t("copy290") : t("copy291")} onClick={() => void onMcpAction(server.config, server.config.enabled ? 'disable' : 'enable')}><Power size={12}/></button><button title={t("copy292")} onClick={() => void confirmInApp(tf("copy293", server.config.name), { title: t("copy292"), confirmLabel: t("copy292"), tone: 'danger' }).then((confirmed) => confirmed ? onMcpAction(server.config, 'remove') : undefined)}><Trash2 size={12}/></button></span></div>)}
              {snapshot.mcpServers.length === 0 && !showMcpForm && <div className="extension-empty"><Network size={24}/><strong>{t("copy128")}</strong><span>{t("copy129")}</span><button className="button secondary" onClick={() => setShowMcpForm(true)}>{t("copy130")}</button></div>}
              {showMcpForm && <div className="mcp-form">
                <label>{t("copy131")}<input value={mcpId} onChange={(event) => setMcpId(event.target.value)} placeholder="lab-tools"/></label>
                <label>{t("copy132")}<input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder={t("copy133")}/></label>
                <label>{t("copy134")}<select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as 'stdio' | 'http')}><option value="stdio">{t("copy135")}</option><option value="http">{t("copy136")}</option></select></label>
                <label>{mcpTransport === 'stdio' ? t("copy137") : t("copy138")}<input value={mcpTarget} onChange={(event) => setMcpTarget(event.target.value)} placeholder={mcpTransport === 'stdio' ? 'node server.mjs' : 'https://example/mcp'}/></label>
                <label>{mcpTransport === 'stdio' ? t("copy139") : t("copy140")}<input value={mcpCredentialName} onChange={(event) => setMcpCredentialName(event.target.value)} placeholder={mcpTransport === 'stdio' ? 'LAB_API_TOKEN' : 'Authorization'}/></label>
                <label>{t("copy141")}<input type="password" value={mcpCredentialValue} onChange={(event) => setMcpCredentialValue(event.target.value)} placeholder={t("copy142")}/></label>
                <div><button className="button secondary" onClick={() => setShowMcpForm(false)}>{t("copy143")}</button><button className="button primary" disabled={!mcpId || !mcpName || !mcpTarget || mcpSaving || Boolean(mcpCredentialName.trim()) !== Boolean(mcpCredentialValue)} onClick={() => void saveMcp()}>{mcpSaving ? t("copy144") : t("copy145")}</button></div>
              </div>}
              {snapshot.mcpServers.length > 0 && <button className="button secondary" onClick={() => setShowMcpForm(true)}>{t("copy130")}</button>}
            </section>
          </>}
          {page === 'security' && <SecuritySettings settings={snapshot.settings} onUpdate={onUpdateSettings}/>}
          {page === 'data' && <><div className="settings-heading"><span className="settings-heading__icon blue"><Database size={20}/></span><div><h2>{t("copy177")}</h2><p>{t("copy178")}</p></div></div><section className="settings-card"><SettingRow title={t("copy179")} description={t("copy180")}><code>{snapshot.project.rootPath}</code></SettingRow><SettingRow title={t("copy181")} description={t("copy182")}><button className="button secondary" onClick={() => void onBackupData()}><HardDrive size={14}/>{t("copy183")}</button></SettingRow><SettingRow title={t("copy184")} description={t("copy185")}><button className="button secondary" onClick={() => void onExportDiagnostics()}><Download size={14}/>{t("copy186")}</button></SettingRow><SettingRow title={t("copy187")} description={t("copy188")}><span className="setting-value good">{t("copy189")}</span></SettingRow></section></>}
          {page === 'about' && <><div className="about-panel"><span className="about-logo"><Sparkles size={27}/></span><h2>{t("copy190")}</h2><p>{t("copy191")}</p><strong>0.1.0</strong><div><Languages size={15}/>{t("copy192")}</div><small>{t("copy193")}</small></div></>}
        </main>
      </div>
    </div>);
}
