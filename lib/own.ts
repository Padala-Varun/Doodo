/**
 * Prototype-safe lookup in a plain-object table. Keys coming from model output
 * or user input (e.g. "constructor", "__proto__") must never resolve to
 * Object.prototype members.
 */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
