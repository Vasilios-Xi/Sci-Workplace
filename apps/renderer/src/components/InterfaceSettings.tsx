import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Check, CircleAlert, CloudSun, Languages, LoaderCircle, MonitorCog, PanelLeft, Palette,
  RotateCcw, Sparkles, Trash2, TriangleAlert, Type,
} from 'lucide-react';
import {
  INTERFACE_THEME_IDS,
  SEMANTIC_COLOR_ROLES,
  isSemanticHexColor,
  type ContentWidth,
  type ConcreteInterfaceThemeId,
  type EditorFont,
  type InterfacePreferences,
  type InterfaceThemeId,
  type SemanticColorRole,
  type SemanticHexColor,
  type SemanticPaletteOverrides,
} from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';
import { timeZoneOffsetLabel } from '../lib/date-time.js';
import { useInterfacePreferences } from '../lib/interface-preferences.js';
import { minimumSemanticContrast, resolveSemanticPalette } from '../lib/semantic-palette.js';
import { SemanticIcon } from './SemanticVisual.js';
import { confirmInApp } from './AppDialog.js';

const themePreview: Record<InterfaceThemeId, { bg: string; surface: string; accent: string; text: string }> = {
  'warm-paper': { bg: '#f3efe5', surface: '#fffdf8', accent: '#6f9b89', text: '#3d403c' },
  'cyan-night': { bg: '#142321', surface: '#213431', accent: '#69ad9e', text: '#e2ece8' },
  auto: { bg: 'linear-gradient(90deg,#f3efe5 0 50%,#172724 50%)', surface: '#f8f8f4', accent: '#719f91', text: '#4e5a56' },
  'pure-white': { bg: '#f5f5f5', surface: '#ffffff', accent: '#303a37', text: '#191d1b' },
  butter: { bg: '#f2f0d9', surface: '#fbfaea', accent: '#84975b', text: '#444836' },
  ming: { bg: '#20232b', surface: '#303440', accent: '#9ba7c6', text: '#eef0f7' },
  absolutely: { bg: '#edf0f5', surface: '#ffffff', accent: '#7285ad', text: '#343c4d' },
  'ready-to-catch': { bg: '#e8f0f1', surface: '#f8fbfa', accent: '#6c9aa0', text: '#35494b' },
  'angry-whale': { bg: '#eceff0', surface: '#fbfcfc', accent: '#5d8ca0', text: '#35474e' },
  'new-warm-paper': { bg: '#eee9dd', surface: '#faf7ef', accent: '#8d7d64', text: '#47423a' },
  'cyan-night-contrast': { bg: '#071b1a', surface: '#102d2a', accent: '#72e0ca', text: '#ffffff' },
  'coral-paper': { bg: '#f8e7df', surface: '#fff8f4', accent: '#c87968', text: '#55423d' },
};

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return <section className="interface-section"><header><SemanticIcon role="neutral" className="interface-section-icon">{icon}</SemanticIcon><div><h3>{title}</h3>{hint && <p>{hint}</p>}</div></header>{children}</section>;
}

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="interface-setting-row"><div><strong>{title}</strong>{hint && <p>{hint}</p>}</div><div>{children}</div></div>;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`interface-toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span/></button>;
}

function StepControl<T extends string | number>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
}) {
  return <div className="interface-step-control" style={{ '--step-count': options.length } as CSSProperties}>{options.map((option) => <button key={String(option.value)} type="button" className={value === option.value ? 'is-active' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)}><span/><small>{option.label}</small></button>)}</div>;
}

function NumberControl({ value, min, max, step = 1, suffix, onChange }: { value: number; min: number; max: number; step?: number; suffix?: string; onChange(value: number): void }) {
  return <label className="interface-number"><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))}/>{suffix && <span>{suffix}</span>}</label>;
}

function availableTimeZones(current: string): Array<{ value: string; label: string }> {
  let zones: string[];
  try { zones = [...Intl.supportedValuesOf('timeZone')]; }
  catch { zones = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York']; }
  if (!zones.includes(current)) zones.push(current);
  return zones.sort((left, right) => left.localeCompare(right)).map((zone) => ({ value: zone, label: `${zone} (${timeZoneOffsetLabel(zone)})` }));
}

function PaletteColorField({
  color,
  label,
  ratio,
  role,
  onChange,
  onReset,
}: {
  color: SemanticHexColor;
  label: string;
  ratio: number;
  role: SemanticColorRole;
  onChange(color: SemanticHexColor): void;
  onReset(): void;
}) {
  const text = copy.interfaceSettings;
  const [draft, setDraft] = useState(color);
  useEffect(() => setDraft(color), [color]);
  const applyDraft = (value: string) => {
    const next = value.toUpperCase();
    setDraft(next as SemanticHexColor);
    if (isSemanticHexColor(next)) onChange(next);
  };
  return <div className="semantic-palette-field" data-role={role}>
    <div className="semantic-palette-field__heading">
      <span className={`semantic-icon semantic-${role}`} aria-hidden="true"><i/></span>
      <strong>{label}</strong>
      <button type="button" className="icon-button semantic-palette-reset" data-testid={`semantic-palette-reset-${role}`} title={text.resetColor} aria-label={text.resetColor} onClick={onReset}><RotateCcw size={13}/></button>
    </div>
    <div className="semantic-palette-inputs">
      <input
        type="color"
        value={color}
        aria-label={label}
        data-testid={`semantic-palette-${role}`}
        onChange={(event) => applyDraft(event.target.value)}
      />
      <input
        className={!isSemanticHexColor(draft) ? 'is-invalid' : ''}
        value={draft}
        maxLength={7}
        spellCheck={false}
        aria-label={`${label} HEX`}
        onChange={(event) => applyDraft(event.target.value)}
        onBlur={() => { if (!isSemanticHexColor(draft)) setDraft(color); }}
      />
    </div>
    {ratio < 3 && <small className="semantic-contrast-warning"><TriangleAlert size={12}/>{text.contrastWarning(ratio.toFixed(2))}</small>}
  </div>;
}

function clonePaletteOverrides(value: SemanticPaletteOverrides): SemanticPaletteOverrides {
  return Object.fromEntries(Object.entries(value).map(([theme, palette]) => [theme, { ...palette }])) as SemanticPaletteOverrides;
}

function SemanticPaletteEditor({
  preferences,
  update,
}: {
  preferences: InterfacePreferences;
  update(patch: { semanticPaletteOverrides: SemanticPaletteOverrides }, options?: { debounced?: boolean }): void;
}) {
  const text = copy.interfaceSettings;
  const [autoTheme, setAutoTheme] = useState<Extract<ConcreteInterfaceThemeId, 'warm-paper' | 'cyan-night'>>('warm-paper');
  const targetTheme: ConcreteInterfaceThemeId = preferences.theme === 'auto' ? autoTheme : preferences.theme;
  const palette = resolveSemanticPalette(preferences, targetTheme);
  const targetOverride = preferences.semanticPaletteOverrides[targetTheme];

  const setColor = (role: SemanticColorRole, color: SemanticHexColor) => {
    const next = clonePaletteOverrides(preferences.semanticPaletteOverrides);
    next[targetTheme] = { ...next[targetTheme], [role]: color };
    update({ semanticPaletteOverrides: next }, { debounced: true });
  };
  const resetColor = (role: SemanticColorRole) => {
    const next = clonePaletteOverrides(preferences.semanticPaletteOverrides);
    const target = { ...next[targetTheme] };
    delete target[role];
    if (Object.keys(target).length > 0) next[targetTheme] = target;
    else delete next[targetTheme];
    update({ semanticPaletteOverrides: next });
  };
  const resetTheme = () => {
    const next = clonePaletteOverrides(preferences.semanticPaletteOverrides);
    delete next[targetTheme];
    update({ semanticPaletteOverrides: next });
  };
  const resetAll = () => {
    void confirmInApp(text.resetAllConfirm, { title: text.resetAll, confirmLabel: text.resetAll, tone: 'danger' }).then((confirmed) => {
      if (confirmed) update({ semanticPaletteOverrides: {} });
    });
  };

  return <div className="semantic-palette-editor" data-testid="semantic-palette">
    <div className="semantic-palette-editor__title">
      <div><h4>{text.semanticPalette}</h4><p>{text.semanticPaletteHint}</p></div>
      <div className="semantic-palette-editor__actions">
        <button type="button" data-testid="semantic-palette-reset-theme" onClick={resetTheme} disabled={!targetOverride}><RotateCcw size={13}/>{text.resetTheme}</button>
        <button type="button" data-testid="semantic-palette-reset-all" onClick={resetAll} disabled={Object.keys(preferences.semanticPaletteOverrides).length === 0}><Trash2 size={13}/>{text.resetAll}</button>
      </div>
    </div>
    {preferences.theme === 'auto' && <div className="semantic-palette-auto-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={autoTheme === 'warm-paper'} data-testid="semantic-palette-auto-light" className={autoTheme === 'warm-paper' ? 'is-active' : ''} onClick={() => setAutoTheme('warm-paper')}>{text.autoLight}</button>
      <button type="button" role="tab" aria-selected={autoTheme === 'cyan-night'} data-testid="semantic-palette-auto-dark" className={autoTheme === 'cyan-night' ? 'is-active' : ''} onClick={() => setAutoTheme('cyan-night')}>{text.autoDark}</button>
    </div>}
    <div className="semantic-palette-grid">
      {SEMANTIC_COLOR_ROLES.map((role) => <PaletteColorField
        key={`${targetTheme}-${role}`}
        role={role}
        label={text.semanticRoles[role]}
        color={palette[role]}
        ratio={minimumSemanticContrast(palette[role], targetTheme)}
        onChange={(color) => setColor(role, color)}
        onReset={() => resetColor(role)}
      />)}
    </div>
    <p className="semantic-palette-default-note">{text.palettePreset}: {text.themes[targetTheme][0]} · {SEMANTIC_COLOR_ROLES.filter((role) => targetOverride?.[role] !== undefined).length}/6</p>
  </div>;
}

export function InterfaceSettings() {
  const { preferences, restartRequired, saveError, saveStatus, update } = useInterfacePreferences();
  const text = copy.interfaceSettings;
  const zones = useMemo(() => availableTimeZones(preferences.timeZone), [preferences.timeZone]);
  const widthOptions: Array<{ value: ContentWidth; label: string }> = [640, 720, 800, 'unbounded'].map((value) => ({ value: value as ContentWidth, label: value === 'unbounded' ? text.unlimited : String(value) }));
  const setMarkdown = (patch: Partial<InterfacePreferences['markdown']>, debounced = false) => update({ markdown: patch }, { debounced });

  return <div className="interface-settings-page" data-testid="settings-interface-page">
    <header className="interface-page-heading"><h2>{text.title}</h2><p>{text.subtitle}</p></header>

    <Section icon={<Palette size={16}/>} title={text.theme}>
      <div className="theme-card-grid" role="radiogroup" aria-label={text.theme}>
        {INTERFACE_THEME_IDS.map((id) => {
          const [name, description] = text.themes[id];
          const preview = themePreview[id];
          return <button
            type="button"
            role="radio"
            aria-checked={preferences.theme === id}
            data-testid={`theme-card-${id}`}
            key={id}
            className={`theme-card ${preferences.theme === id ? 'is-active' : ''}`}
            style={{ '--theme-preview-bg': preview.bg, '--theme-preview-surface': preview.surface, '--theme-preview-accent': preview.accent, '--theme-preview-text': preview.text } as CSSProperties}
            onClick={() => update({ theme: id })}
          ><span className="theme-card__preview"><i/><i/><i/></span><span><strong>{name}</strong><small>{description}</small></span>{preferences.theme === id && <Check size={13}/>}</button>;
        })}
      </div>
      <SemanticPaletteEditor preferences={preferences} update={update}/>
    </Section>

    <Section icon={<Type size={16}/>} title={text.font}>
      <div className="reading-font-cards">
        <button type="button" className={preferences.readingFont === 'serif' ? 'is-active' : ''} onClick={() => update({ readingFont: 'serif' })}><span className="serif-sample">Aa</span><span><strong>{text.serif}</strong><small>{text.serifHint}</small></span>{preferences.readingFont === 'serif' && <Check size={13}/>}</button>
        <button type="button" className={preferences.readingFont === 'sans' ? 'is-active' : ''} onClick={() => update({ readingFont: 'sans' })}><span className="sans-sample">Aa</span><span><strong>{text.sans}</strong><small>{text.sansHint}</small></span>{preferences.readingFont === 'sans' && <Check size={13}/>}</button>
      </div>
      <div className="interface-card">
        <Row title={text.bodySize} hint={text.bodySizeHint}><StepControl value={preferences.readingSizeDelta} options={[-2, -1, 0, 1, 2].map((value) => ({ value: value as InterfacePreferences['readingSizeDelta'], label: value > 0 ? `+${value}` : String(value) }))} onChange={(readingSizeDelta) => update({ readingSizeDelta })}/></Row>
        <Row title={text.chatWidth} hint={text.chatWidthHint}><StepControl value={preferences.chatWidth} options={widthOptions} onChange={(chatWidth) => update({ chatWidth })}/></Row>
      </div>
    </Section>

    <Section icon={<CloudSun size={16}/>} title={text.appearance}>
      <div className="interface-card"><Row title={text.paperTexture} hint={text.paperTextureHint}><Toggle label={text.paperTexture} checked={preferences.paperTexture} onChange={(paperTexture) => update({ paperTexture })}/></Row><Row title={text.sunnyMode} hint={text.sunnyModeHint}><Toggle label={text.sunnyMode} checked={preferences.sunnyMode} onChange={(sunnyMode) => update({ sunnyMode })}/></Row></div>
    </Section>

    <Section icon={<MonitorCog size={16}/>} title={text.system}>
      <div className="interface-card"><Row title={text.hardwareAcceleration} hint={text.hardwareAccelerationHint}><Toggle label={text.hardwareAcceleration} checked={preferences.hardwareAcceleration} onChange={(hardwareAcceleration) => update({ hardwareAcceleration })}/></Row>{restartRequired && <div className="interface-restart-note"><CircleAlert size={13}/>{text.restartRequired}</div>}</div>
    </Section>

    <Section icon={<PanelLeft size={16}/>} title={text.sidebar}>
      <div className="interface-card"><Row title={text.singleLineSessions} hint={text.singleLineSessionsHint}><Toggle label={text.singleLineSessions} checked={preferences.singleLineSessions} onChange={(singleLineSessions) => update({ singleLineSessions })}/></Row></div>
    </Section>

    <Section icon={<Sparkles size={16}/>} title={text.editor} hint={text.editorHint}>
      <div className="interface-card editor-interface-card">
        <Row title={text.editorFont}><select value={preferences.markdown.font} onChange={(event) => setMarkdown({ font: event.target.value as EditorFont })}><option value="follow-reading">{text.followReading}</option><option value="serif">{text.serif}</option><option value="sans">{text.sans}</option><option value="monospace">{text.monospace}</option></select></Row>
        <Row title={text.bodySize}><NumberControl value={preferences.markdown.bodySize} min={12} max={24} suffix="px" onChange={(bodySize) => setMarkdown({ bodySize }, true)}/></Row>
        <Row title={text.contentWidth}><StepControl value={preferences.markdown.contentWidth} options={widthOptions} onChange={(contentWidth) => setMarkdown({ contentWidth })}/></Row>
        <Row title={text.heading1}><NumberControl value={preferences.markdown.heading1Size} min={20} max={48} suffix="px" onChange={(heading1Size) => setMarkdown({ heading1Size }, true)}/></Row>
        <Row title={text.heading2}><NumberControl value={preferences.markdown.heading2Size} min={18} max={40} suffix="px" onChange={(heading2Size) => setMarkdown({ heading2Size }, true)}/></Row>
        <Row title={text.heading3}><NumberControl value={preferences.markdown.heading3Size} min={14} max={32} suffix="px" onChange={(heading3Size) => setMarkdown({ heading3Size }, true)}/></Row>
        <Row title={text.lineHeight}><NumberControl value={preferences.markdown.lineHeight} min={1.2} max={2.2} step={0.1} onChange={(lineHeight) => setMarkdown({ lineHeight }, true)}/></Row>
        <Row title={text.contentPadding}><NumberControl value={preferences.markdown.contentPadding} min={0} max={64} suffix="px" onChange={(contentPadding) => setMarkdown({ contentPadding }, true)}/></Row>
      </div>
    </Section>

    <Section icon={<Languages size={16}/>} title={text.localeRegion}>
      <div className="interface-card">
        <Row title={text.language} hint={text.languageHint}><select value="zh-CN" aria-label={text.language}><option value="zh-CN">{text.languageOptions.simplifiedChinese}</option><option disabled>{text.languageOptions.traditionalChinese} · {text.comingSoon}</option><option disabled>{text.languageOptions.japanese} · {text.comingSoon}</option><option disabled>{text.languageOptions.korean} · {text.comingSoon}</option><option disabled>{text.languageOptions.english} · {text.comingSoon}</option></select></Row>
        <Row title={text.timeZone} hint={text.timeZoneHint}><select className="timezone-select" value={preferences.timeZone} onChange={(event) => update({ timeZone: event.target.value })}>{zones.map((zone) => <option key={zone.value} value={zone.value}>{zone.label}</option>)}</select></Row>
      </div>
    </Section>

    <div className={`interface-save-status ${saveStatus}`} role="status">
      {saveStatus === 'saving' ? <LoaderCircle className="spin" size={13}/> : saveStatus === 'error' ? <CircleAlert size={13}/> : <Check size={13}/>}
      <span>{saveStatus === 'saving' ? text.saving : saveStatus === 'error' ? text.saveFailed : text.saved}</span>
      {saveError && <small title={saveError}>{saveError}</small>}
    </div>
  </div>;
}
