import { invokePlugin } from "./runtime.js";
export function sumSquares(values) {
    let total = 0;
    for (const value of values) {
        total += value * value;
    }
    return total;
}
export function buildRows(count) {
    const rows = [];
    for (let index = 0; index < count; index += 1) {
        rows.push({ id: index });
    }
    return rows;
}
export function sortValues(values) {
    return values.slice().sort((left, right) => left - right);
}
export function loopAroundPlugin(plugin, name, count) {
    for (let index = 0; index < count; index += 1) {
        invokePlugin(plugin, name);
    }
}
export function factorial(value) {
    if (value <= 1) {
        return 1;
    }
    return value * factorial(value - 1);
}
export const recursiveArrow = (value) => (value <= 1 ? 1 : value * recursiveArrow(value - 1));
