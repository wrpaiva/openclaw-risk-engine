import { isIP } from 'node:net';

// Módulo puro (ADR-0011, opção O2). Único lugar de src com os literais de curinga de bind.

export type BindScope = 'loopback' | 'private-network';
export type HttpTransport = 'plaintext-encrypted-overlay';

export const BIND_SCOPES: readonly BindScope[] = ['loopback', 'private-network'];
export const PLAINTEXT_ENCRYPTED_OVERLAY: HttpTransport = 'plaintext-encrypted-overlay';

/** IPv4 127.0.0.0/8 ou ::1 (IP literal; hostnames, inclusive 'localhost', são rejeitados). */
export function isLoopbackIp(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return host.split('.')[0] === '127' && host.split('.').every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p));
  if (family === 6) return host === '::1' || /^(0:){7}0*1$/.test(host);
  return false;
}

/** Único curinga aceito, só na grafia canônica; '::' e demais grafias são rejeitados. */
export function isAcceptedWildcard(host: string): boolean {
  return host === '0.0.0.0';
}

/** Valida o host contra o escopo. Retorna a mensagem fixa de erro (sem o valor recebido) ou null se aceito. */
export function resolveBind(scope: BindScope, host: string): string | null {
  if (scope === 'loopback') return isLoopbackIp(host) ? null : 'RISK_HTTP_HOST: escopo loopback aceita só IP de loopback';
  return isAcceptedWildcard(host) ? null : 'RISK_HTTP_HOST: escopo private-network aceita só 0.0.0.0';
}

/** Host que o healthcheck interno do contêiner deve sondar. */
export function healthProbeHost(http: { readonly bindScope: BindScope; readonly host: string }): string {
  return http.bindScope === 'loopback' ? http.host : '127.0.0.1';
}
