import type { Clock } from '../../application/ports/Clock.js';
import { UtcInstant } from '../../domain/value-objects/UtcInstant.js';

export class SystemClock implements Clock {
  now(): UtcInstant {
    return UtcInstant.fromEpochMillis(Date.now());
  }
}
