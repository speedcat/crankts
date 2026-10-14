/** Known iteration counts: per call, the outer body runs `outer` times and the inner body `outer × inner` times. */
export function nestedLoops(outer: number, inner: number): number {
  let acc = 0;
  for (let i = 0; i < outer; i += 1) {
    acc ^= i;
    for (let j = 0; j < inner; j += 1) {
      acc = (acc + Math.imul(i, j)) | 0;
    }
  }
  return acc;
}
