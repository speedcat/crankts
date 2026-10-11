import { filterWith } from "./index.ts";
const items = ["ab", "aab", "b", "cab"];
for (let index = 0; index < 50; index += 1) filterWith(items, index % 10 === 0 ? "c" : "a+b");
