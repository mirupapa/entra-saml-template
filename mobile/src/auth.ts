import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

export type User = { sessionExpiresAt?: number; absoluteExpiresAt?: number; id: string; tenantId: string | null; departments: { code: string; name: string }[]; roles: { appId: string; roleId: string; name: string }[]; nameId: string; objectId: string | null; name: string | null; email: string | null };
const storageKey = 'saml.mobile.session';
const redirectUri = 'samlsample://auth/callback';
function backend() {
  const configured = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (!configured) throw new Error('mobile/.env の EXPO_PUBLIC_BACKEND_URL を設定してください。');
  const url = new URL(configured);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost' && Platform.OS === 'ios'))
    throw new Error('BackendにはHTTPS URLが必要です。iOS SimulatorのみHTTP localhostで確認できます。');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Backend URLはOriginのみ指定してください。');
  return url.origin;
}
async function randomHex() {
  return Array.from(await Crypto.getRandomBytesAsync(32), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function jsonRequest(path: string, body: unknown) {
  const response = await fetch(backend() + path, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('認証処理に失敗しました。BackendとEntraの設定を確認してください。');
  return response.json();
}
export async function currentUser(peek = false): Promise<User | null> {
  const token = await SecureStore.getItemAsync(storageKey);
  if (!token) return null;
  const response = await fetch(backend() + `/api/mobile/me${peek ? '?peek=1' : ''}`, { credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) { await SecureStore.deleteItemAsync(storageKey); return null; }
  if (!response.ok) throw new Error('ユーザー情報を取得できません。');
  const data = await response.json();
  return { ...data.user, sessionExpiresAt: data.expiresAt, absoluteExpiresAt: data.absoluteExpiresAt };
}
export async function login(switchAccount = false): Promise<User | null> {
  if (Platform.OS === 'web') throw new Error('このサンプルはiOS / AndroidのDevelopment Buildで実行してください。');
  const verifier = await randomHex();
  const state = await randomHex();
  const challenge = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, { encoding: Crypto.CryptoEncoding.HEX });
  const { loginUrl } = await jsonRequest('/auth/mobile/start', { state, challenge });
  const start = new URL(loginUrl);
  if (start.origin !== backend() || start.pathname !== '/auth/login') throw new Error('Unexpected login URL');
  const result = await WebBrowser.openAuthSessionAsync(loginUrl, redirectUri, { preferEphemeralSession: switchAccount });
  if (result.type !== 'success') return null;
  const url = new URL(result.url);
  if (`${url.protocol}//${url.host}${url.pathname}` !== redirectUri || url.searchParams.get('state') !== state) throw new Error('認証応答がログイン要求と一致しません。');
  const code = url.searchParams.get('code');
  if (!code || !/^[a-f0-9]{64}$/.test(code)) throw new Error('認証コードを受信できませんでした。');
  const { sessionToken, user, expiresAt, absoluteExpiresAt } = await jsonRequest('/auth/mobile/exchange', { code, verifier });
  if (typeof sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(sessionToken)) throw new Error('Invalid session response');
  await SecureStore.setItemAsync(storageKey, sessionToken);
  return { ...user, sessionExpiresAt: Date.parse(expiresAt), absoluteExpiresAt };
}
export async function logout() {
  const token = await SecureStore.getItemAsync(storageKey);
  if (token) {
    const response = await fetch(backend() + '/auth/mobile/logout', { method: 'POST', credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('ログアウトできません。通信を確認して再試行してください。');
  }
  await SecureStore.deleteItemAsync(storageKey);
}
