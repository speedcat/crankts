import { describe, expect, it } from "vitest";
import { entityAtOffset, indexModuleSource, type ModuleIndex } from "../src/observe/entity/index.js";

function index(source: string, file = "src/sample.ts"): ModuleIndex {
  return indexModuleSource(source, { absoluteFile: `/project/${file}`, file, packageName: "app", packagePath: file });
}

function names(module: ModuleIndex): string[] {
  return module.entities.map((entity) => entity.qualifiedName);
}

describe("observe entity keys", () => {
  it("names declared, inferred, context, and ordinal functions", () => {
    const module = index(`
export function parse(input: string) {
  const items = input.split(",").map((item) => item.trim());
  items.forEach(function visit(item) { return item; });
  return () => items;
}
export class GraphParser {
  private handler: () => void;
  constructor() { this.handler = () => {}; }
  parseNode(node: unknown) { return node; }
  get size() { return 1; }
  set size(value: number) {}
  static create = () => new GraphParser();
  #hidden() {}
}
const helpers = {
  normalize(value: string) { return value; },
  inner: { deep: () => 1 },
};
export default function () {}
exports.legacy = function () {};
register({ run() {} });
[1, 2].map(async (value) => value);
(() => {})();
`);
    expect(names(module)).toEqual([
      "(module)",
      "parse",
      "parse/input.split().map#cb0",
      "parse/visit",
      "parse/return",
      "GraphParser.constructor",
      "GraphParser.handler",
      "GraphParser.parseNode",
      "GraphParser.get size",
      "GraphParser.set size",
      "GraphParser.create",
      "GraphParser.#hidden",
      "helpers.normalize",
      "helpers.inner.deep",
      "default",
      "legacy",
      "register#arg0.run",
      "….map#cb0",
      "anon#1",
    ]);
    expect(module.entities.find((entity) => entity.qualifiedName === "anon#1")?.flags).toEqual(["anonymousOrdinal"]);
    expect(module.entities.find((entity) => entity.qualifiedName === "GraphParser.get size")?.kind).toBe("getter");
    expect(module.entities.find((entity) => entity.qualifiedName === "GraphParser.constructor")?.kind).toBe("constructor");
    expect(module.entities.find((entity) => entity.qualifiedName === "….map#cb0")?.async).toBe(true);
    expect(module.entities[1]?.key).toBe("app::src/sample.ts::parse");
  });

  it("suffixes later duplicates and leaves the first name alone", () => {
    const module = index(`
function build(items: number[]) {
  items.map((a) => a);
  items.map((b) => b);
}
`);
    expect(names(module)).toEqual(["(module)", "build", "build/items.map#cb0", "build/items.map#cb0~2"]);
  });

  it("labels callbacks with a leading string argument", () => {
    const module = index(`
describe("parser", () => {
  it("parses", () => {});
  it(\`handles empty\`, function () {});
});
measure("symbols", () => 1);
measure(name, () => 2);
`);
    expect(names(module)).toEqual([
      "(module)",
      'describe("parser")#cb1',
      'describe("parser")#cb1/it("parses")#cb1',
      'describe("parser")#cb1/it("handles empty")#cb1',
      'measure("symbols")#cb1',
      "measure#cb1",
    ]);
  });

  it("keeps keys stable when a function is inserted above", () => {
    const body = `
export function buildIndex(items: number[]) {
  return items.map((item) => item * 2).filter(function (value) { return value > 1; });
}
const table = { lookup: (key: string) => key };
`;
    const before = index(body);
    const after = index(`export function inserted() { return [1].map((x) => x); }\n${body}`);
    const keysBefore = before.entities.map((entity) => entity.key);
    const keysAfter = new Set(after.entities.map((entity) => entity.key));
    for (const key of keysBefore) expect(keysAfter.has(key)).toBe(true);
  });

  it("fingerprints ignore position, comments, and the function's own name; shape ignores identifiers", async () => {
    const { fingerprints } = await import("../src/observe/entity/index.js");
    const first = index("function alpha(a: number) { return a + 1; }");
    const moved = index("// comment\n\n\nfunction beta(a: number) {\n  // inner\n  return a + 1;\n}");
    const renamed = index("function gamma(b: number) { return b + 2; }");
    const fingerprintOf = (module: ModuleIndex) => {
      const node = module.entities[1]?.node;
      if (!node) throw new Error("expected a function");
      return fingerprints(node);
    };
    expect(fingerprintOf(moved)).toEqual(fingerprintOf(first));
    expect(fingerprintOf(renamed).body).not.toBe(fingerprintOf(first).body);
    expect(fingerprintOf(renamed).shape).toBe(fingerprintOf(first).shape);
  });

  it("finds the innermost entity at an offset, falling back to module init", () => {
    const source = "const top = 1;\nfunction outer() {\n  const inner = () => 2;\n  return inner;\n}\n";
    const module = index(source);
    expect(entityAtOffset(module, source.indexOf("() => 2")).qualifiedName).toBe("outer/inner");
    expect(entityAtOffset(module, source.indexOf("return inner")).qualifiedName).toBe("outer");
    expect(entityAtOffset(module, 0).qualifiedName).toBe("(module)");
  });
});
