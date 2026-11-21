import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const SESSION_KEY = 'jansathi.guest-id.v1';
export async function getGuestId(): Promise<string> {
  const saved = await SecureStore.getItemAsync(SESSION_KEY);
  if (saved && /^[a-f0-9-]{36}$/.test(saved)) return saved;
  const id = await Crypto.randomUUID();
  await SecureStore.setItemAsync(SESSION_KEY, id);
  return id;
}
export async function rotateGuestId(): Promise<string> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  return getGuestId();
}

export async function readSetting<T extends string>(key: string, fallback: T): Promise<T> {
  try { return ((await SecureStore.getItemAsync(`jansathi.${key}`)) as T) || fallback; }
  catch { return fallback; }
}
export async function saveSetting(key: string, value: string) {
  try { await SecureStore.setItemAsync(`jansathi.${key}`, value); } catch { /* Keep the active choice for this run. */ }
}
