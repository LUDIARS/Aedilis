/** Serializes a connection's work without retaining a rejected tail promise. */
export class ConnectionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> { await this.tail; }
}
