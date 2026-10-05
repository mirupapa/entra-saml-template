const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class GraphClient {
  private token?: { value: string; expires: number };
  constructor(readonly tenant: string, private client: string, private secret: string, private target: string, private redirectUrl: string, private transport: typeof fetch = fetch) {}
  private async accessToken() {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const response = await this.transport(`https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), body: new URLSearchParams({ client_id: this.client, client_secret: this.secret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }) });
    if (!response.ok) throw new Error('Graph認証に失敗しました。クライアントID・シークレット・管理者同意を確認してください。');
    const data = await response.json();
    if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) throw new Error('Graph認証応答が不正です。');
    this.token = { value: data.access_token, expires: Date.now() + Math.max(0, data.expires_in - 60) * 1000 };
    return this.token.value;
  }
  private async call(path: string, body?: unknown) {
    const response = await this.transport(`https://graph.microsoft.com/v1.0/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`Graph処理に失敗しました（HTTP ${response.status}）。権限・外部招待設定を確認してください。`);
    return response.json();
  }
  async check() {
    const target = await this.call(`servicePrincipals/${this.target}?$select=id,appId,displayName,appRoles`);
    const roles = (target.appRoles || []).filter((r: any) => r.isEnabled && r.allowedMemberTypes?.includes('User'));
    const roleId = roles.length ? roles.find((r: any) => r.id === process.env.GRAPH_TARGET_APP_ROLE_ID)?.id : '00000000-0000-0000-0000-000000000000';
    if (!roleId) throw new Error('対象アプリにロールがあります。GRAPH_TARGET_APP_ROLE_IDを設定してください。');
    return { name: target.displayName, roleId };
  }
  async invite(email: string, name: string) {
    const data = await this.call('invitations', { invitedUserEmailAddress: email, invitedUserDisplayName: name, invitedUserType: 'Guest', inviteRedirectUrl: this.redirectUrl, sendInvitationMessage: true, invitedUserMessageInfo: { messageLanguage: 'ja-JP' } });
    if (!guid.test(data.invitedUser?.id || '')) throw new Error('招待応答のユーザーIDを確認できません。再送せずEntra側を確認してください。');
    return data.invitedUser.id.toLowerCase() as string;
  }
  async assign(objectId: string, roleId: string) {
    if (!guid.test(objectId)) throw new Error('Invalid object ID');
    const path = `servicePrincipals/${this.target}/appRoleAssignedTo`;
    let page: string | undefined = `${path}?$select=principalId,appRoleId&$top=100`;
    while (page) {
      const existing = await this.call(page);
      if (existing.value?.some((r: any) => r.principalId?.toLowerCase() === objectId && r.appRoleId === roleId)) return;
      const next = existing['@odata.nextLink'];
      if (next) {
        const url = new URL(next);
        if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== `/v1.0/${path}`) throw new Error('Invalid Graph pagination link');
        page = url.pathname.slice('/v1.0/'.length) + url.search;
      } else page = undefined;
    }
    await this.call(path, { principalId: objectId, resourceId: this.target, appRoleId: roleId });
  }
}
export function loadGraph(env: NodeJS.ProcessEnv = process.env) {
  const keys = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_TARGET_SERVICE_PRINCIPAL_ID'];
  if (!keys.some(k => env[k]?.trim())) return undefined;
  if (keys.some(k => !env[k]?.trim())) throw new Error('Graph設定が不足しています。');
  for (const k of [keys[0], keys[1], keys[3]]) if (!guid.test(env[k]!)) throw new Error(`${k} must be a GUID`);
  const tenant = env.GRAPH_TENANT_ID!.toLowerCase();
  if (env.SAML_IDP_ISSUER?.toLowerCase() !== `https://sts.windows.net/${tenant}/`) throw new Error('GraphとSAMLのテナントが一致していません。');
  const redirectUrl = env.GRAPH_INVITE_REDIRECT_URL || 'https://myapps.microsoft.com/';
  const url = new URL(redirectUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Graph invitation redirect must use HTTPS');
  return new GraphClient(tenant, env.GRAPH_CLIENT_ID!, env.GRAPH_CLIENT_SECRET!, env.GRAPH_TARGET_SERVICE_PRINCIPAL_ID!, redirectUrl);
}
