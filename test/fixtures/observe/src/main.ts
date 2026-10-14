import { allocateTemporaries, retainSome } from "./alloc-loop.ts";
import { processTokens } from "./amplified.ts";
import { buildIndex } from "./anonymous.ts";
import { useDependency } from "./dep-heavy.ts";
import { expensiveTransform } from "./expensive.ts";
import { nestedLoops } from "./loops.ts";
import { walkAll } from "./recursive.ts";

let sink = 0;
sink ^= expensiveTransform(1);
sink ^= processTokens();
sink ^= useDependency();
sink ^= walkAll();
sink ^= buildIndex(Array.from({ length: 100 }, (_, index) => index));
for (let call = 0; call < 3; call += 1) sink ^= nestedLoops(50, 200);
sink ^= allocateTemporaries();
retainSome();
if (sink === 42) console.log("unlikely");
