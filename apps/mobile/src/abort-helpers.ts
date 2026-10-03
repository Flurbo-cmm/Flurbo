export function installAbortHelpers(Signal: typeof AbortSignal, Controller: typeof AbortController) {
  if (typeof Signal.timeout !== 'function') Object.defineProperty(Signal, 'timeout', { configurable: true, value(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 2_147_483_647) throw new RangeError('Invalid request timeout');
    const controller = new Controller();
    const timer = setTimeout(() => controller.abort(), ms);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return controller.signal;
  } });
  if (typeof Signal.any !== 'function') Object.defineProperty(Signal, 'any', { configurable: true, value(signals: AbortSignal[]) {
    const controller = new Controller();
    const abort = () => { controller.abort(); for (const signal of signals) signal.removeEventListener('abort', abort); };
    for (const signal of signals) { if (signal.aborted) { abort(); break; } signal.addEventListener('abort', abort, { once: true }); }
    return controller.signal;
  } });
}
