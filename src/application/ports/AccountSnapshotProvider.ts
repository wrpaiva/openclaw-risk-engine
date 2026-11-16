/**
 * Snapshot da carteira paper vindo da fonte de verdade externa (D-05 em aberto).
 * Contém SOMENTE posições abertas e saldos: reservas são do motor e somadas por ele,
 * para não existirem duas fontes de verdade concorrentes (SPEC §7.1).
 */
export interface AccountSnapshot {
  readonly accountId: string;
  readonly snapshotVersion: string;
  readonly asOf: string;
  readonly equityBase: string;
  readonly availableCashBase: string;
  readonly realizedDailyPnlBase: string;
  readonly unrealizedPnlBase: string;
  readonly openGrossExposureBase: string;
  readonly openInstrumentExposureBase: string;
  readonly openStrategyExposureBase: string;
}

export interface AccountSnapshotProvider {
  /** `null` = indisponível → bloqueio; exceção → erro de infraestrutura, sem autorização. */
  getSnapshot(accountId: string, instrument: string, strategyId: string): Promise<AccountSnapshot | null>;
}
