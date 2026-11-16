import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isOpaqueId } from '../../domain/schemaSupport.js';

export interface PrincipalCredential {
  readonly principalId: string;
  readonly kind: 'AGENT' | 'PAPER_EXECUTOR';
  readonly tokenSha256: readonly string[];
}

export class PrincipalCredentialsError extends Error {
  override readonly name = 'PrincipalCredentialsError';
}

const fileSchema = z
  .object({
    version: z.literal(1),
    principals: z
      .array(
        z
          .object({
            principalId: z.string().refine(isOpaqueId),
            kind: z.enum(['AGENT', 'PAPER_EXECUTOR']),
            tokenSha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Valida o conteúdo já lido; mensagens nunca incluem hashes nem trechos do arquivo. */
export function parsePrincipalCredentials(raw: string): readonly PrincipalCredential[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PrincipalCredentialsError('arquivo de principais: JSON inválido');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) throw new PrincipalCredentialsError('arquivo de principais: formato ou versão inválidos');
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const principal of parsed.data.principals) {
    if (ids.has(principal.principalId)) throw new PrincipalCredentialsError('arquivo de principais: principalId repetido');
    ids.add(principal.principalId);
    for (const hash of principal.tokenSha256) {
      if (hashes.has(hash)) throw new PrincipalCredentialsError('arquivo de principais: hash de token duplicado');
      hashes.add(hash);
    }
  }
  return parsed.data.principals;
}

export function loadPrincipalCredentials(path: string): readonly PrincipalCredential[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new PrincipalCredentialsError('arquivo de principais ausente ou ilegível');
  }
  return parsePrincipalCredentials(raw);
}
