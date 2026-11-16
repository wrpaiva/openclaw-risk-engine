import type { ReadinessProbe, ReadinessReport } from './ports/ReadinessProbe.js';

export interface CheckReadinessResult {
  readonly ready: boolean;
  readonly checks: ReadinessReport;
}

export interface CheckReadinessDeps {
  readonly probe: ReadinessProbe;
  /** Verdadeiro durante o desligamento ordenado: o serviço deixa de ficar pronto. */
  readonly isDraining: () => boolean;
}

const ALL_FAIL: ReadinessReport = { database: 'FAIL', schema: 'FAIL', privileges: 'FAIL', reconciliation: 'FAIL' };

/**
 * Single-flight (sem TTL): /health/ready é público e cada verificação ocupa conexões do pool; N chamadas simultâneas
 * disparam uma só verificação. O draining é lido por chamada, depois do resultado.
 * Fail-closed: probe que lança, ou drenagem em curso, nunca produz `ready = true`. */
export class CheckReadiness {
  /** Verificação em voo: chamadas concorrentes a compartilham (single-flight, sem cache nem TTL). */
  private inFlight: Promise<ReadinessReport> | null = null;

  constructor(private readonly deps: CheckReadinessDeps) {}

  private probe(): Promise<ReadinessReport> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = (async (): Promise<ReadinessReport> => {
      try {
        return await this.deps.probe.check();
      } catch {
        return ALL_FAIL;
      }
    })();
    this.inFlight = flight;
    // Libera ao terminar: a próxima chamada depois disso faz uma verificação nova (nada fica em cache).
    void flight.finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    return flight;
  }

  async execute(): Promise<CheckReadinessResult> {
    const checks = await this.probe();
    const draining = this.safeDraining();
    const ready = checks.database === 'OK' && checks.schema === 'OK' && checks.privileges === 'OK' && checks.reconciliation === 'OK' && !draining;
    return { ready, checks };
  }

  private safeDraining(): boolean {
    try {
      return this.deps.isDraining();
    } catch {
      return true;
    }
  }
}
