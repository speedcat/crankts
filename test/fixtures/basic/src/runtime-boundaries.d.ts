declare module "pg" {
  export function query(statement: string): string;
}

declare module "@intentweave/sqlite-compat" {
  export interface Database {
    prepare(statement: string): StatementCompat;
  }
  export interface StatementCompat {
    all(): unknown[];
  }
}

declare module "typed-helper" {
  export function typedLookup(value: string): string;
}

declare module "unknown-helper" {
  export const unknownLookup: any;
}