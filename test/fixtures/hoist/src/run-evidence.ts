import { diffRows, indexTwice } from "./evidence.ts";
const rows = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, value: i }));
for (let round = 0; round < 5; round += 1) diffRows({ base: rows, emitted: [...rows] });
const sink = { add(_doc: { id: string; text: string }) {} };
indexTwice(rows, sink, sink);
