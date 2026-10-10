export function acceptsUnknown(value) {
    return value;
}
export function invokesEval(source) {
    return eval(source);
}
export function wrapsProxy(value) {
    return new Proxy(value, {});
}
export function readsReflectively(target, key) {
    return Reflect.get(target, key);
}
export function callsMissingHelper() {
    missingHelper();
}
export function cycleA() {
    cycleB();
}
export function cycleB() {
    cycleA();
    missingHelper();
}
