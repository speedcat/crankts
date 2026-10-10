import { writeFileSync } from "node:fs";
let sharedCounter = 0;
export function pureHelper(value) {
    return value + 1;
}
export function mutateArgument(values) {
    values.push(1);
    return values;
}
export function callerMutatesArgument(values) {
    return mutateArgument(values);
}
export function allocateLocally(count) {
    const values = [];
    for (let index = 0; index < count; index += 1) {
        values.push(index);
    }
    return values;
}
export function readSharedState() {
    return sharedCounter + Date.now();
}
export function incrementSharedState() {
    sharedCounter += 1;
    return sharedCounter;
}
export function effectCycleA() {
    return effectCycleB();
}
export function effectCycleB() {
    sharedCounter += 1;
    return effectCycleA();
}
export function writeFile(path) {
    writeFileSync(path, "data");
}
export async function fetchText(url) {
    const response = await fetch(url);
    return response.text();
}
export function startFetch(url) {
    fetch(url);
}
