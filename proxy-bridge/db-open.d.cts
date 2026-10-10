// Types for db-open.cjs — the subset of better-sqlite3 both backends provide.
export interface SqliteRunResult { changes: number; lastInsertRowid: number | bigint }
export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
  pragma(stmt: string): unknown[];
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
}
export interface OpenDbOptions { readonly?: boolean; fileMustExist?: boolean; timeout?: number; requireFrom?: string }
export declare function openDb(file: string, opts?: OpenDbOptions): SqliteDb;
export declare function sqliteBackend(requireFrom?: string): 'better' | 'node';
