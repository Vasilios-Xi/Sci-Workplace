import { useMemo, useState } from 'react';
import { ArrowRight, Bot, Check, Sparkles } from 'lucide-react';
import type { PrimaryAgentProfileUpdate } from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';

interface PrimaryAgentOnboardingProps {
  onConfigure(update: PrimaryAgentProfileUpdate): Promise<void>;
}

export function PrimaryAgentOnboarding({ onConfigure }: PrimaryAgentOnboardingProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const normalizedName = name.normalize('NFC').trim();
  const characterCount = useMemo(() => [...normalizedName].length, [normalizedName]);
  const valid = characterCount >= 1 && characterCount <= 32;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onConfigure({ name: normalizedName });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return <div className="primary-agent-onboarding" data-testid="primary-agent-onboarding">
    <section className="primary-agent-onboarding__card" role="dialog" aria-modal="true" aria-labelledby="primary-agent-onboarding-title">
      <header>
        <span className="primary-agent-onboarding__mark"><Sparkles size={19}/></span>
        <small>{copy.onboarding.eyebrow}</small>
        <h1 id="primary-agent-onboarding-title">{copy.onboarding.title}</h1>
        <p>{copy.onboarding.description}</p>
      </header>

      <div className="primary-agent-onboarding__role">
        <span className="primary-agent-onboarding__avatar"><Bot size={22}/></span>
        <div>
          <small>{copy.onboarding.roleLabel}</small>
          <strong>{copy.onboarding.roleName}</strong>
          <p>{copy.onboarding.roleDescription}</p>
        </div>
      </div>

      <ul className="primary-agent-onboarding__principles">
        <li><Check size={14}/><span>{copy.onboarding.temporaryAgents}</span></li>
        <li><Check size={14}/><span>{copy.onboarding.neutralRole}</span></li>
      </ul>

      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="primary-agent-name">
          <span>{copy.onboarding.nameLabel}</span>
          <small>{copy.onboarding.nameHint}</small>
        </label>
        <input
          id="primary-agent-name"
          data-testid="primary-agent-name"
          autoFocus
          autoComplete="off"
          maxLength={64}
          value={name}
          placeholder={copy.onboarding.namePlaceholder}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="primary-agent-onboarding__error" role="alert">{error}</p>}
        <button data-testid="primary-agent-start" type="submit" disabled={!valid || saving}>
          <span>{saving ? copy.onboarding.saving : copy.onboarding.start}</span>
          {!saving && <ArrowRight size={15}/>}
        </button>
      </form>
    </section>
  </div>;
}
