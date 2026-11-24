/**
 * A Map that forgets its oldest entries past `limit`: a cache fed by unbounded keys (a live color picker) stays small.
 * `weigh`: what one entry counts toward `limit` (1 by default), for a cache whose entries differ a lot in size. The
 * entry just set always stays, however heavy.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly limit: number;
  readonly #weigh: (key: K, value: V) => number;
  #weight = 0;

  constructor(limit: number, weigh: (key: K, value: V) => number = () => 1) {
    super();
    this.limit = limit;
    this.#weigh = weigh;
  }

  override set(key: K, value: V): this {
    this.delete(key);
    super.set(key, value);
    this.#weight += this.#weigh(key, value);
    for (const oldest of this.keys()) {
      if (this.#weight <= this.limit || oldest === key) break;
      this.delete(oldest);
    }
    return this;
  }

  override delete(key: K): boolean {
    if (!super.has(key)) return false;
    this.#weight -= this.#weigh(key, super.get(key) as V);
    return super.delete(key);
  }

  override clear(): void {
    this.#weight = 0;
    super.clear();
  }
}
