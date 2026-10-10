declare function missingHelper(): void;

export function acceptsUnknown(value: unknown): unknown {
  return value;
}

export function invokesEval(source: string): unknown {
  return eval(source);
}

export function wrapsProxy<T extends object>(value: T): T {
  return new Proxy(value, {});
}

export function readsReflectively(target: object, key: PropertyKey): unknown {
  return Reflect.get(target, key);
}

export function callsMissingHelper(): void {
  missingHelper();
}

export function cycleA(): void {
  cycleB();
}

export function cycleB(): void {
  cycleA();
  missingHelper();
}