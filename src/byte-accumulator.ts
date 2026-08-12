/** Growable byte sink with amortized O(n) append and line extraction. */
export class ByteAccumulator {
  private buffer = new Uint8Array(256);
  private length = 0;

  get size(): number {
    return this.length;
  }

  append(data: Uint8Array): void {
    if (this.length + data.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + data.length) {
        capacity *= 2;
      }
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(data, this.length);
    this.length += data.length;
  }

  indexOf(byte: number): number {
    return this.buffer.subarray(0, this.length).indexOf(byte);
  }

  consumeThrough(index: number): void {
    const remaining = this.length - (index + 1);
    if (remaining > 0) {
      this.buffer.copyWithin(0, index + 1, this.length);
    }
    this.length = remaining;
  }

  /** Returns the next complete line (without LF, trailing CR stripped) or null. */
  takeLine(): Uint8Array | null {
    const newline = this.indexOf(0x0a);
    if (newline === -1) {
      return null;
    }
    let end = newline;
    if (end > 0 && this.buffer[end - 1] === 0x0d) {
      end -= 1;
    }
    const line = this.buffer.slice(0, end);
    this.consumeThrough(newline);
    return line;
  }

  /** Returns everything remaining as one line (trailing CR stripped) and clears. */
  takeAll(): Uint8Array {
    let end = this.length;
    if (end > 0 && this.buffer[end - 1] === 0x0d) {
      end -= 1;
    }
    const tail = this.buffer.slice(0, end);
    this.length = 0;
    return tail;
  }

  reset(): void {
    this.length = 0;
  }
}
