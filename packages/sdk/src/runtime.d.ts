// The SDK core compiles against ES2022 only (no DOM, no Node types), so it cannot reach window,
// localStorage or React. These are the few platform primitives it relies on; all exist in modern
// browsers and Node 24. Transports and storage are injected by the caller.
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
  throwIfAborted(): void;
}
declare var AbortSignal: {
  prototype: AbortSignal;
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};
interface AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void; }
declare var AbortController: { prototype: AbortController; new (): AbortController };
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function structuredClone<T>(value: T): T;
