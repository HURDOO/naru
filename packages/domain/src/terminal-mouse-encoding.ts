/** DEC mouse encoding state omitted by xterm's terminal serializer. */
export class TerminalMouseEncoding {
  #mode: 1006 | 1016 | null = null;

  set(params: readonly (number | number[])[], enabled: boolean): void {
    for (const param of params) {
      if (param === 1006 || param === 1016) this.#mode = enabled ? param : null;
    }
  }

  reset(): void {
    this.#mode = null;
  }

  serialize(): string {
    return `\u001b[?1006;1016l${this.#mode === null ? "" : `\u001b[?${this.#mode}h`}`;
  }
}
