export type CheckStatus = 'OK' | 'FAIL';

/** Resultado por verificação; nunca carrega mensagens de erro, credenciais ou nomes de objetos. */
export interface ReadinessReport {
  readonly database: CheckStatus;
  readonly schema: CheckStatus;
  readonly privileges: CheckStatus;
  /** FAIL enquanto a reconciliação pós-restauração está pendente (ou o estado não pôde ser lido). */
  readonly reconciliation: CheckStatus;
}

export interface ReadinessProbe {
  /** Implementações nunca lançam: qualquer falha vira FAIL. */
  check(): Promise<ReadinessReport>;
}
