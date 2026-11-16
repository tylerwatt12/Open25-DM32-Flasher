// SPDX-License-Identifier: GPL-3.0-or-later
// Current operation only. Reloading the page never restores a prior session.
export class Journal {
  #receipt;
  clear() { this.#receipt = undefined; }
  async write(receipt) { this.#receipt = structuredClone(receipt); }
  async latest(simulated = false) {
    return this.#receipt?.simulated === simulated ? structuredClone(this.#receipt) : undefined;
  }
}
