/**
 * Structured logger (§27).
 *
 * Errors are never swallowed. `error()` requires a recovery string — the caller has to
 * state what the system did about the failure, which makes "catch and ignore" awkward
 * to write and obvious to read.
 */

import type { JsonValue, LogEntry, LogLevel, StateTransition } from '../core/types';
import { describeError, toJsonSafe } from '../core/validate';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export class Logger {
  private readonly entries: LogEntry[] = [];
  private readonly transitions: StateTransition[] = [];
  private readonly maxEntries: number;
  private minLevel: LogLevel = 'DEBUG';
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  debug(phase: number, source: string, message: string, data?: Record<string, unknown>): void {
    this.push({ level: 'DEBUG', phase, source, message, data });
  }
  info(phase: number, source: string, message: string, data?: Record<string, unknown>): void {
    this.push({ level: 'INFO', phase, source, message, data });
  }
  warn(phase: number, source: string, message: string, data?: Record<string, unknown>): void {
    this.push({ level: 'WARN', phase, source, message, data });
  }

  /**
   * Record a real failure. `recovery` is mandatory: §27 requires the recovery action to
   * be part of the record, and requiring it here means an error can't be logged without
   * the author deciding what happens next.
   */
  error(
    phase: number,
    source: string,
    message: string,
    recovery: string,
    err?: unknown,
    data?: Record<string, unknown>,
  ): void {
    const merged: Record<string, unknown> = { ...(data ?? {}) };
    if (err !== undefined) merged['error'] = describeError(err);
    this.push({ level: 'ERROR', phase, source, message, data: merged, recovery });
  }

  private push(input: {
    level: LogLevel;
    phase: number;
    source: string;
    message: string;
    data?: Record<string, unknown>;
    recovery?: string;
  }): void {
    if (LEVEL_ORDER[input.level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: input.level,
      phase: input.phase,
      source: input.source,
      message: input.message,
      ...(input.data !== undefined
        ? { data: toJsonSafe(input.data) as Record<string, JsonValue> }
        : {}),
      ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    for (const fn of this.listeners) fn(entry);
  }

  transition(subject: string, from: string, to: string, reason: string): void {
    const t: StateTransition = { timestamp: Date.now(), subject, from, to, reason };
    this.transitions.push(t);
    this.info(-1, 'StateTransition', `${subject}: ${from} -> ${to}`, { reason });
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }
  getErrors(): readonly LogEntry[] {
    return this.entries.filter((e) => e.level === 'ERROR');
  }
  getTransitions(): readonly StateTransition[] {
    return this.transitions;
  }
}

/** Process-wide logger. Phase 0 has one app instance, so one logger is correct here. */
export const logger = new Logger();
