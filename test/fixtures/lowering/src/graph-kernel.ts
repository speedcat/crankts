// Kernel-style TypeScript of the MVP-9b GRAPH_BATCH kernel (evaluation/graph-native-poc/src/lib.rs):
// WCC over a CSR graph plus articulation points per component, written in the Kernel IR subset.
// Output: [componentCount, { memberCount, members..., articulationCount, tieCount,
//   { node, impact, componentsAfterRemoval, largestRemainingPart } * tieCount } * componentCount]

export function graphBatch(
  offsets: Uint32Array,
  neighbors: Uint32Array,
  fileRank: Uint32Array,
  line: Uint32Array,
): number[] {
  const nodeCount = offsets.length - 1;
  const output: number[] = [0];
  let componentCount = 0;

  const visited = new Array<boolean>(nodeCount).fill(false);
  const discovery = new Array<number>(nodeCount).fill(-1);
  const low = new Array<number>(nodeCount).fill(0);
  const parent = new Array<number>(nodeCount).fill(-1);
  const childCount = new Array<number>(nodeCount).fill(0);
  const subtreeSize = new Array<number>(nodeCount).fill(0);
  const separatedCount = new Array<number>(nodeCount).fill(0);
  const separatedSum = new Array<number>(nodeCount).fill(0);
  const separatedMax = new Array<number>(nodeCount).fill(0);

  for (let start = 0; start < nodeCount; start++) {
    if (visited[start]) {
      continue;
    }
    const members: number[] = [];
    const pending: number[] = [start];
    while (pending.length > 0) {
      const current = pending[pending.length - 1];
      pending.pop();
      if (visited[current]) {
        continue;
      }
      visited[current] = true;
      members.push(current);
      for (let slot = offsets[current]; slot < offsets[current + 1]; slot++) {
        const neighbor = neighbors[slot];
        if (!visited[neighbor]) {
          pending.push(neighbor);
        }
      }
    }
    members.sort((left, right) => fileRank[left] - fileRank[right] || line[left] - line[right]);

    output.push(members.length);
    for (const member of members) {
      output.push(member);
    }

    // Tarjan over the component; roots in member order, like islands.ts.
    const size = members.length;
    let clock = 0;
    for (const root of members) {
      if (discovery[root] !== -1) {
        continue;
      }
      clock += 1;
      discovery[root] = clock;
      low[root] = clock;
      parent[root] = -1;
      childCount[root] = 0;
      subtreeSize[root] = 1;
      const frameNode: number[] = [root];
      const frameNext: number[] = [offsets[root]];
      while (frameNode.length > 0) {
        const top = frameNode.length - 1;
        const node = frameNode[top];
        const slot = frameNext[top];
        if (slot < offsets[node + 1]) {
          frameNext[top] = slot + 1;
          const neighbor = neighbors[slot];
          if (neighbor === parent[node]) {
            continue;
          }
          if (discovery[neighbor] === -1) {
            clock += 1;
            discovery[neighbor] = clock;
            low[neighbor] = clock;
            parent[neighbor] = node;
            childCount[neighbor] = 0;
            subtreeSize[neighbor] = 1;
            childCount[node] += 1;
            frameNode.push(neighbor);
            frameNext.push(offsets[neighbor]);
          } else {
            low[node] = Math.min(low[node], discovery[neighbor]);
          }
          continue;
        }

        frameNode.pop();
        frameNext.pop();
        const nodeParent = parent[node];
        if (nodeParent === -1) {
          continue;
        }
        const nodeSize = subtreeSize[node];
        subtreeSize[nodeParent] += nodeSize;
        low[nodeParent] = Math.min(low[nodeParent], low[node]);
        if (parent[nodeParent] === -1 || low[node] >= discovery[nodeParent]) {
          separatedCount[nodeParent] += 1;
          separatedSum[nodeParent] += nodeSize;
          separatedMax[nodeParent] = Math.max(separatedMax[nodeParent], nodeSize);
        }
      }
    }

    // Articulation points, keeping every point tied for the largest (impact, parts).
    const tieNode: number[] = [];
    const tieImpact: number[] = [];
    const tieParts: number[] = [];
    const tieLargest: number[] = [];
    let articulationCount = 0;
    let bestImpact = -1;
    let bestParts = -1;
    for (const member of members) {
      const isRoot = parent[member] === -1;
      const isArticulation = isRoot ? childCount[member] > 1 : separatedCount[member] > 0;
      if (isArticulation) {
        let parts = separatedCount[member];
        let largest = separatedMax[member];
        if (!isRoot) {
          const remainder = size - 1 - separatedSum[member];
          if (remainder > 0) {
            parts += 1;
            largest = Math.max(largest, remainder);
          }
        }
        const impact = Math.max(0, size - 1 - largest);
        articulationCount += 1;
        if (impact > bestImpact || (impact === bestImpact && parts > bestParts)) {
          bestImpact = impact;
          bestParts = parts;
          tieNode.length = 0;
          tieImpact.length = 0;
          tieParts.length = 0;
          tieLargest.length = 0;
        }
        if (impact === bestImpact && parts === bestParts) {
          tieNode.push(member);
          tieImpact.push(impact);
          tieParts.push(parts);
          tieLargest.push(largest);
        }
      }
      discovery[member] = -1;
      parent[member] = -1;
      childCount[member] = 0;
      separatedCount[member] = 0;
      separatedSum[member] = 0;
      separatedMax[member] = 0;
    }

    output.push(articulationCount);
    output.push(tieNode.length);
    for (let tie = 0; tie < tieNode.length; tie++) {
      output.push(tieNode[tie]);
      output.push(tieImpact[tie]);
      output.push(tieParts[tie]);
      output.push(tieLargest[tie]);
    }
    componentCount += 1;
  }

  output[0] = componentCount;
  return output;
}
