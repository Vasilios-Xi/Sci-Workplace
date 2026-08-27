import { useEffect, useState } from 'react';
import { Check, Trash2, Upload } from 'lucide-react';
import type { UserProfile, UserProfileUpdate } from '@openlab/protocol';
import { hanaZhCN as copy } from '../i18n/zh-CN.js';

interface UserSettingsProps {
  profile: UserProfile;
  onSave(update: UserProfileUpdate): Promise<void>;
}

type SaveState = 'idle' | 'saving' | 'saved';

export function UserSettings({ profile, onSave }: UserSettingsProps) {
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.profile);
  const [avatar, setAvatar] = useState<string | undefined>(profile.avatar);
  const [avatarError, setAvatarError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    setName(profile.name);
    setDescription(profile.profile);
    setAvatar(profile.avatar);
    setAvatarError('');
    setSaveError('');
    setSaveState('idle');
  }, [profile.avatar, profile.name, profile.profile]);

  const normalizedName = name.trim();
  const initial = [...(normalizedName || copy.userSettings.defaultName)][0]?.toLocaleUpperCase('zh-CN');
  const nameValid = [...normalizedName].length >= 1 && [...normalizedName].length <= 32;

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      setAvatar(await avatarFromFile(file));
      setAvatarError('');
      setSaveState('idle');
    } catch (cause) {
      setAvatarError(cause instanceof Error ? cause.message : copy.userSettings.avatarInvalid);
    }
  };

  const save = async () => {
    if (!nameValid || saveState === 'saving') return;
    setSaveError('');
    setSaveState('saving');
    try {
      await onSave({ name: normalizedName, profile: description, avatar: avatar ?? null });
      setSaveState('saved');
      window.setTimeout(() => setSaveState('idle'), 1_500);
    } catch (cause) {
      setSaveState('idle');
      setSaveError(cause instanceof Error ? cause.message : copy.userSettings.saveFailed);
    }
  };

  return <div className="user-settings" data-testid="settings-user-page">
    <div className="settings-heading user-settings__heading">
      <div><h2>{copy.userSettings.title}</h2><p>{copy.userSettings.subtitle}</p></div>
    </div>
    <section className="user-settings__form">
      <div className="user-settings__avatar-area">
        <span className="user-settings__avatar" aria-label={copy.userSettings.avatar}>
          {avatar ? <img src={avatar} alt="" draggable={false}/> : initial}
        </span>
        <div className="user-settings__avatar-actions">
          <label className="button secondary">
            <Upload size={14}/>{copy.userSettings.uploadAvatar}
            <input
              data-testid="user-profile-avatar-upload"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void uploadAvatar(file);
              }}
            />
          </label>
          {avatar && <button type="button" className="button secondary" onClick={() => { setAvatar(undefined); setAvatarError(''); setSaveState('idle'); }}><Trash2 size={14}/>{copy.userSettings.removeAvatar}</button>}
        </div>
        {avatarError && <small className="user-settings__error" role="alert">{avatarError}</small>}
      </div>

      <label className="user-settings__field">
        <span><strong>{copy.userSettings.name}</strong><small>{copy.userSettings.nameHint}</small></span>
        <input
          data-testid="user-profile-name"
          value={name}
          maxLength={32}
          aria-invalid={!nameValid}
          onChange={(event) => { setName(event.target.value); setSaveState('idle'); setSaveError(''); }}
        />
        {!nameValid && <small className="user-settings__error" role="alert">{copy.userSettings.invalidName}</small>}
      </label>

      <label className="user-settings__field">
        <span><strong>{copy.userSettings.profile}</strong><small>{copy.userSettings.profileHint}</small></span>
        <textarea
          data-testid="user-profile-text"
          rows={10}
          maxLength={12_000}
          value={description}
          placeholder={copy.userSettings.profilePlaceholder}
          onChange={(event) => { setDescription(event.target.value); setSaveState('idle'); setSaveError(''); }}
        />
        <small className="user-settings__counter">{[...description].length.toLocaleString('zh-CN')} / 12,000</small>
      </label>

      <div className="user-settings__footer">
        {saveError && <span className="user-settings__error" role="alert">{saveError}</span>}
        <button data-testid="user-profile-save" className="button primary" disabled={!nameValid || saveState === 'saving'} onClick={() => void save()}>
          {saveState === 'saved' && <Check size={14}/>} {saveState === 'saving' ? copy.userSettings.saving : saveState === 'saved' ? copy.userSettings.saved : copy.userSettings.save}
        </button>
      </div>
    </section>
  </div>;
}

async function avatarFromFile(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(copy.userSettings.avatarInvalid);
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error(copy.userSettings.avatarSourceTooLarge);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(copy.userSettings.avatarInvalid);
  }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error(copy.userSettings.avatarInvalid);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(copy.userSettings.avatarInvalid);
    const sourceSize = Math.min(bitmap.width, bitmap.height);
    const sourceX = Math.floor((bitmap.width - sourceSize) / 2);
    const sourceY = Math.floor((bitmap.height - sourceSize) / 2);
    context.drawImage(bitmap, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 256, 256);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', .86));
    if (!blob || blob.size > 256 * 1024) throw new Error(copy.userSettings.avatarProcessedTooLarge);
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(copy.userSettings.avatarInvalid));
      reader.onload = () => typeof reader.result === 'string' && reader.result.startsWith('data:image/webp;base64,')
        ? resolve(reader.result)
        : reject(new Error(copy.userSettings.avatarInvalid));
      reader.readAsDataURL(blob);
    });
  } finally {
    bitmap.close();
  }
}
