import { heavy } from "fakedep";
import { UNIT_MS } from "./units.ts";

/** Three units spent inside a dependency, caused by this function. */
export function useDependency(): number {
  return heavy(3 * UNIT_MS);
}
