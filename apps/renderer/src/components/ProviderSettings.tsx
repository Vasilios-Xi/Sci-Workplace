import { useEffect, useState } from 'react';
import {
  BrainCircuit, Check, CircleAlert, ExternalLink, Eye, EyeOff, Image as ImageIcon, KeyRound, LogIn,
  LogOut, Power, RefreshCw, Save, Server, Wrench,
} from 'lucide-react';
import type { HarnessSettings, ModelDescriptor, ModelProviderConfig, ModelProviderId, ModelProviderState } from '@openlab/protocol';
import { agentV3ZhCN as v3Copy, hanaZhCN as copy } from '../i18n/zh-CN.js';
import { confirmInApp } from './AppDialog.js';
import { ModelPicker } from './ModelPicker.js';

interface ProviderSettingsProps {
  providers: ModelProviderState[];
  models: ModelDescriptor[];
  settings: HarnessSettings;
  onConfigure(id: ModelProviderId, patch: Partial<Pick<ModelProviderConfig, 'enabled' | 'credentialId' | 'baseUrl'>>, secret?: string): Promise<void>;
  onRefresh(id: ModelProviderId): Promise<void>;
  onOAuthStart(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<unknown>;
  onOAuthLogout(id: Extract<ModelProviderId, 'chatgpt-oauth' | 'grok-oauth'>): Promise<void>;
  onUpdateSettings(patch: Partial<HarnessSettings>): Promise<void>;
}

const categories = ['oauth', 'coding_plan', 'api'] as const;

function providerHint(state: ModelProviderState): string {
  if (state.definition.auth === 'oauth') return copy.providers.oauthHint;
  if (state.definition.category === 'coding_plan') return copy.providers.codingPlanHint;
  if (state.definition.local) return copy.providers.localHint;
  return copy.providers.apiHint;
}

function ProviderModelList({ state }: { state: ModelProviderState }) {
  return <section className="provider-models">
    <header><strong>{copy.providers.models}</strong><span>{copy.providers.modelCount(state.models.length)}</span></header>
    {state.models.length === 0
      ? <div className="provider-empty-models">{copy.providers.noModels}</div>
      : <div>{state.models.map((model) => <article key={model.id}>
        <div><strong>{model.label}</strong><code>{model.nativeId ?? model.id}</code></div>
        <span className="provider-model-badges">
          {model.supportsVision && <em title={copy.providers.vision}><ImageIcon size={12}/></em>}
          {model.supportsThinking && <em title={copy.providers.thinking}><BrainCircuit size={12}/></em>}
          {model.supportsTools ? <em title={copy.providers.tools}><Wrench size={12}/></em> : <small>{copy.providers.chatOnly}</small>}
          <b>{copy.providers.context(model.contextWindow)}</b>
        </span>
      </article>)}</div>}
  </section>;
}

function ProviderDetail(props: ProviderSettingsProps & { state: ModelProviderState }) {
  const { state } = props;
  const [baseUrl, setBaseUrl] = useState(state.config.baseUrl ?? state.definition.defaultBaseUrl ?? '');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setBaseUrl(state.config.baseUrl ?? state.definition.defaultBaseUrl ?? '');
    setSecret('');
    setError(undefined);
  }, [state.config.baseUrl, state.definition.defaultBaseUrl, state.definition.id]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const oauthId = state.definition.id === 'chatgpt-oauth' || state.definition.id === 'grok-oauth' ? state.definition.id : undefined;
  const statusLabel = copy.providers.statuses[state.status];
  const testId = state.definition.id === 'deepseek' ? 'deepseek-key' : undefined;
  const saveTestId = state.definition.id === 'deepseek' ? 'deepseek-key-save' : undefined;

  return <div className="provider-detail">
    <header className="provider-detail__header">
      <div><h3>{state.definition.label}</h3><p>{copy.providers.notes[state.definition.id]}</p></div>
      <button className="provider-docs" onClick={() => void window.openlab?.openExternal(state.definition.docsUrl)}><ExternalLink size={13}/>{copy.providers.officialDocs}</button>
    </header>
    <div className="provider-connection-row">
      <span className={`provider-status provider-status--${state.status}`}><i/>{statusLabel}</span>
      {state.account && <span className="provider-account"><Check size={12}/>{state.account.label ?? copy.providers.loggedIn}{state.account.plan ? ` · ${state.account.plan}` : ''}</span>}
      <button className="provider-power" title={state.config.enabled ? copy.providers.disabled : copy.providers.enabled} disabled={busy || state.status === 'unavailable'} onClick={() => void run(async () => await props.onConfigure(state.definition.id, { enabled: !state.config.enabled }))}><Power size={13}/>{state.config.enabled ? copy.providers.disabled : copy.providers.enabled}</button>
    </div>

    {state.definition.auth === 'oauth' && oauthId && <section className="provider-auth-card">
      <div><LogIn size={16}/><span><strong>{copy.providers.account}</strong><small>{providerHint(state)}</small></span></div>
      {state.status === 'connected'
        ? <button className="button secondary" disabled={busy} onClick={() => void confirmInApp(copy.providers.logoutWarning, { title: copy.providers.logout, confirmLabel: copy.providers.logout, tone: 'danger' }).then((confirmed) => confirmed ? run(async () => await props.onOAuthLogout(oauthId)) : undefined)}><LogOut size={13}/>{copy.providers.logout}</button>
        : <button className="button primary" disabled={busy || state.status === 'unavailable'} onClick={() => void run(async () => await props.onOAuthStart(oauthId))}><LogIn size={13}/>{copy.providers.login}</button>}
    </section>}

    {state.definition.auth !== 'oauth' && <section className="provider-config-card">
      <label><span>{copy.providers.endpoint}<small>{state.definition.configurableBaseUrl ? state.definition.local ? copy.providers.localEndpoint : '' : copy.providers.fixedEndpoint}</small></span><div className="provider-input"><Server size={13}/><input value={baseUrl} readOnly={!state.definition.configurableBaseUrl} onChange={(event) => setBaseUrl(event.target.value)}/></div></label>
      {state.definition.auth === 'api_key' && <label><span>{copy.providers.apiKey}<small>{state.credentialConfigured ? copy.providers.replaceKey : providerHint(state)}</small></span><div className="provider-input"><KeyRound size={13}/><input data-testid={testId} type={showSecret ? 'text' : 'password'} value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={state.credentialConfigured ? copy.providers.replaceKey : 'sk-…'}/><button onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeOff size={13}/> : <Eye size={13}/>}</button></div></label>}
      <div className="provider-config-actions"><small>{providerHint(state)}</small><button data-testid={saveTestId} className="button primary" disabled={busy || (state.definition.auth === 'api_key' && !state.credentialConfigured && !secret.trim())} onClick={() => void run(async () => { await props.onConfigure(state.definition.id, { enabled: true, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) }, secret); setSecret(''); })}>{busy ? <RefreshCw className="spin" size={13}/> : <Save size={13}/>} {busy ? copy.providers.saving : copy.providers.save}</button></div>
    </section>}

    {state.definition.policyNotice && <div className="provider-policy"><CircleAlert size={13}/><span><strong>{copy.providers.policy}</strong>{state.definition.policyNotice}</span></div>}
    {state.status === 'unavailable' && <div className="provider-policy"><CircleAlert size={13}/><span>{copy.providers.unavailableHint}</span></div>}
    {oauthId && <div className="provider-policy provider-policy--quiet"><BrainCircuit size={13}/><span>{copy.providers.toolBridgeNotice}</span></div>}
    {error && <div className="provider-error"><CircleAlert size={13}/><span>{error}</span></div>}
    {state.error && !error && <div className="provider-error"><CircleAlert size={13}/><span>{state.error}</span></div>}
    <ProviderModelList state={state}/>
    <button className="provider-refresh" disabled={busy} onClick={() => void run(async () => await props.onRefresh(state.definition.id))}><RefreshCw size={13}/>{copy.providers.refresh}</button>
  </div>;
}

export function ProviderSettings(props: ProviderSettingsProps) {
  const [selectedId, setSelectedId] = useState<ModelProviderId>(props.providers.some((item) => item.definition.id === 'deepseek')
    ? 'deepseek'
    : props.providers.find((item) => item.status === 'connected')?.definition.id ?? props.providers[0]?.definition.id ?? 'deepseek');
  useEffect(() => {
    if (props.providers.length > 0 && !props.providers.some((item) => item.definition.id === selectedId)) setSelectedId(props.providers[0]!.definition.id);
  }, [props.providers, selectedId]);
  const selected = props.providers.find((item) => item.definition.id === selectedId);
  const models = props.models;
  const visionModels = models.filter((model) => model.supportsVision);

  return <div className="provider-settings">
    <div className="settings-heading provider-heading"><span className="settings-heading__icon cyan"><Server size={20}/></span><div><h2>{copy.providers.title}</h2><p>{copy.providers.subtitle}</p></div></div>
    <section className="provider-console">
      <aside className="provider-list">{categories.map((category) => <div key={category}>
        <h4>{copy.providers.categories[category]}</h4>
        {props.providers.filter((state) => state.definition.category === category).map((state) => <button key={state.definition.id} className={state.definition.id === selectedId ? 'is-active' : ''} onClick={() => setSelectedId(state.definition.id)}>
          <span className={`provider-dot provider-dot--${state.status}`}/><strong>{state.definition.label}</strong>{state.models.length > 0 && <em>{state.models.length}</em>}
        </button>)}
      </div>)}</aside>
      <main>{selected ? <ProviderDetail {...props} state={selected}/> : <div className="provider-empty-models">{copy.providers.noConnectedModels}</div>}</main>
    </section>
    <section className="provider-routing settings-card">
      <header><strong>{copy.providers.otherModels}</strong><span>{copy.providers.modelCount(models.length)}</span></header>
      <div>
        <div className="provider-routing-field"><span><strong>{v3Copy.providerRouting.agentModel}</strong><small>{v3Copy.providerRouting.agentModelHint}</small></span><ModelPicker models={models} value={props.settings.defaultAgentModel} label={v3Copy.providerRouting.agentModel} variant="field" testId="provider-agent-model-picker" menuTestId="provider-agent-model-picker-menu" onChange={(defaultAgentModel) => void props.onUpdateSettings({ defaultAgentModel })}/></div>
        <div className="provider-routing-field"><span><strong>{v3Copy.providerRouting.utilityModel}</strong><small>{v3Copy.providerRouting.utilityModelHint}</small></span><ModelPicker models={models} value={props.settings.utilityModel} label={v3Copy.providerRouting.utilityModel} variant="field" testId="provider-utility-model-picker" menuTestId="provider-utility-model-picker-menu" onChange={(utilityModel) => void props.onUpdateSettings({ utilityModel })}/></div>
        <div className="provider-routing-field"><span><strong>{v3Copy.providerRouting.paperReaderTextModel}</strong><small>{v3Copy.providerRouting.paperReaderTextModelHint}</small></span><ModelPicker models={models} value={props.settings.paperReaderTextModel} label={v3Copy.providerRouting.paperReaderTextModel} variant="field" testId="provider-paper-reader-text-model-picker" menuTestId="provider-paper-reader-text-model-picker-menu" onChange={(paperReaderTextModel) => void props.onUpdateSettings({ paperReaderTextModel })}/></div>
        <div className="provider-routing-field"><span><strong>{v3Copy.providerRouting.paperReaderVisionModel}</strong><small>{v3Copy.providerRouting.paperReaderVisionModelHint}</small></span><ModelPicker models={visionModels} value={props.settings.paperReaderVisionModel} label={v3Copy.providerRouting.paperReaderVisionModel} variant="field" testId="provider-paper-reader-vision-model-picker" menuTestId="provider-paper-reader-vision-model-picker-menu" onChange={(paperReaderVisionModel) => void props.onUpdateSettings({ paperReaderVisionModel })}/></div>
      </div>
      {models.length === 0 && <p>{copy.providers.noConnectedModels}</p>}
    </section>
  </div>;
}
