/**
 * Minimal type declarations for sql.js (https://sql.js.org).
 * The upstream @types/sql.js package is ambient-only and pulls in the
 * emscripten type set, so this module declares just the API surface the
 * extension uses.
 */
declare module "sql.js" {
  type SqlValue = number | string | Uint8Array | null;
  type BindParams = SqlValue[] | Record<string, SqlValue> | null;

  class Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(): SqlValue[];
    getColumnNames(): string[];
    free(): boolean;
    reset(): void;
    run(values?: BindParams): void;
  }

  class Database {
    constructor(data?: ArrayLike<number> | null);
    run(sql: string, params?: BindParams): void;
    exec(sql: string, params?: BindParams): Array<{
      columns: string[];
      values: SqlValue[][];
    }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    getRowsModified(): number;
    close(): void;
  }

  interface SqlJsStatic {
    Database: typeof Database;
    Statement: typeof Statement;
  }

  function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;

  namespace initSqlJs {
    export { Database, Statement };
    export type { BindParams, SqlJsStatic, SqlValue };
  }

  export = initSqlJs;
}
