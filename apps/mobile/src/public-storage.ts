// Public metadata and transaction tracking only. Never store signing material.
export class PublicStorage {
  private values = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private failure: unknown;
  private persist: (key: string, value: string | null) => Promise<void>;
  constructor(persist: (key: string, value: string | null) => Promise<void>) { this.persist = persist; }
  hydrate(entries: readonly (readonly [string, string | null])[]) {
    for (const [key, value] of entries) if (key.startsWith('flurbo.') && value !== null && value.length < 200_000) this.values.set(key, value);
  }
  getItem = (key: string) => this.values.get(key) ?? null;
  keys = () => [...this.values.keys()];
  setItem = (key: string, value: string) => {
    if (this.failure) throw new Error('Transaction tracking storage is unavailable. Restart the app before trading.');
    if (!key.startsWith('flurbo.') || value.length > 200_000) throw new Error('Invalid public storage entry');
    this.values.set(key, value); this.enqueue(key, value);
  };
  removeItem = (key: string) => { this.values.delete(key); this.enqueue(key, null); };
  private enqueue(key: string, value: string | null) {
    this.writes = this.writes.then(() => this.persist(key, value)).catch(error => { this.failure = error; });
  }
  flush = async () => { await this.writes; if (this.failure) throw new Error('Transaction tracking could not be saved. Check existing transactions before trying again.'); };
}
