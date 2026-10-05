import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { currentUser, login, logout, type User } from './src/auth';
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [busy, setBusy] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  async function action(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '処理に失敗しました。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void action(async () => setUser(await currentUser())); }, []);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void currentUser(true).then(result => {
        setUser(result);
        if (!result) setError('セッションが終了しました。再ログインしてください。');
      }).catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [userId]);
  return <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
    <StatusBar style="dark" /><Text style={styles.eyebrow}>ENTRA ID / SAML 2.0 / EXPO</Text>
    <Text style={styles.title}>SAML Login Sample</Text><Text style={styles.intro}>システムブラウザで認証し、アプリへ戻ります。</Text>
    <View style={styles.card}><Text style={styles.status}>{user ? '認証済み' : '未認証'}</Text><Text style={styles.heading}>{user ? 'Login Success' : 'Entra IDでログイン'}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {user?.sessionExpiresAt && user.sessionExpiresAt - now <= 300000 ? <View><Text style={styles.error}>{(user.absoluteExpiresAt || 0) - now <= 300000 ? 'ログインから8時間の上限です。作業を保存して再ログインしてください。' : '無操作による終了まで5分以内です。「ログイン状態を再確認」で延長できます。'}</Text></View> : null}
      {user && <>{[['Name', user.name], ['Email', user.email], ['NameID', user.nameId], ['Object ID', user.objectId], ['User ID', user.id], ['Tenant ID', user.tenantId], ['部署', user.departments?.map(d => d.name).join('、') || '未所属'], ['権限', user.roles?.map(r => `${r.appId}: ${r.name}`).join('、') || '未付与']].map(([label, value]) => <View key={label} style={styles.field}><Text style={styles.label}>{label}</Text><Text selectable style={styles.value}>{value || 'Claim未設定'}</Text></View>)}</>}
      {busy ? <ActivityIndicator accessibilityLabel="処理中" /> : <Pressable accessibilityRole="button" style={styles.button} onPress={() => void action(async () => { if (user) { await logout(); setUser(null); } else { const result = await login(); if (result) setUser(result); } })}><Text style={styles.buttonText}>{user ? 'ログアウト' : 'Entra IDでログイン →'}</Text></Pressable>}
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void action(async () => {
        if (user) { await logout(); setUser(null); }
        const result = await login(true); if (result) setUser(result);
      })}><Text style={styles.link}>別のアカウントでログイン</Text></Pressable>
      <Text style={styles.note}>アカウント切り替えは現在のアプリからログアウトします。iOSではブラウザのログイン情報を共有しない認証画面を開きます。</Text>
      <Pressable disabled={busy} accessibilityRole="button" onPress={() => void action(async () => setUser(await currentUser()))}><Text style={styles.link}>ログイン状態を再確認</Text></Pressable>
    </View><Text style={styles.note}>Expo → System Browser → SAML Backend → Entra ID → 一回限りのコード → アプリ用セッション</Text>
  </ScrollView>;
}
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#f4f7fa' }, container: { padding: 24, paddingTop: 80, paddingBottom: 50 }, eyebrow: { fontSize: 11, letterSpacing: 2, color: '#486782', fontWeight: '700' }, title: { fontSize: 32, fontWeight: '700', color: '#172b44', marginTop: 18 }, intro: { color: '#536578', lineHeight: 24, marginVertical: 20 }, card: { backgroundColor: 'white', borderRadius: 18, borderColor: '#dce4eb', borderWidth: 1, padding: 24 }, status: { color: '#146442', marginBottom: 16 }, heading: { fontSize: 24, fontWeight: '700', color: '#172b44', marginBottom: 24 }, field: { marginBottom: 18 }, label: { color: '#627386', fontSize: 12, marginBottom: 6 }, value: { color: '#172b44', fontSize: 16 }, error: { color: '#a02929', marginBottom: 20, lineHeight: 24 }, button: { backgroundColor: '#155cbd', padding: 15, borderRadius: 8, alignItems: 'center' }, buttonText: { color: 'white', fontWeight: '600' }, link: { color: '#155cbd', textAlign: 'center', marginTop: 20 }, note: { color: '#627386', lineHeight: 23, marginTop: 24, fontSize: 12 } });
