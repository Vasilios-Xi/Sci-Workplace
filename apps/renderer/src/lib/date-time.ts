const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}:${JSON.stringify(options)}`;
  const existing = formatterCache.get(key);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone });
  formatterCache.set(key, created);
  return created;
}

export function formatClockTime(timestamp: string, timeZone: string): string {
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

export function formatShortDate(timestamp: string, timeZone: string): string {
  return formatter(timeZone, { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
}

export function formatDateTime(timestamp: string, timeZone: string): string {
  return formatter(timeZone, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

export function zonedDayOrdinal(value: Date | string | number, timeZone: string): number {
  const parts = formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000);
}

export function timeZoneOffsetLabel(timeZone: string, date = new Date()): string {
  try {
    const value = formatter(timeZone, { timeZoneName: 'longOffset' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
    return value?.replace('GMT', 'GMT') ?? 'GMT';
  } catch { return 'GMT'; }
}
