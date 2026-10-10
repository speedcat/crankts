//! GRAPH_BATCH kernel for CrankTS candidate islands: weakly connected components plus
//! articulation points per component, in one call over a CSR graph.
//!
//! Mirrors `findWeaklyConnectedComponents` and `findArticulationPoints` in
//! `src/analysis/islands.ts`, including traversal order. String semantics stay in TypeScript:
//! member order uses a precomputed file rank, and articulation ties on (impact,
//! componentsAfterRemoval) are returned as a tie set for TypeScript's `localeCompare` tie-break.
//!
//! Output layout (flat u32):
//! `[componentCount, { memberCount, members..., articulationCount, tieCount,
//!   { node, impact, componentsAfterRemoval, largestRemainingPart } * tieCount } * componentCount]`

use napi::bindgen_prelude::Uint32Array;
use napi_derive::napi;

const UNSET: u32 = u32::MAX;

#[napi(js_name = "graphBatch")]
pub fn graph_batch(
    offsets: Uint32Array,
    neighbors: Uint32Array,
    file_rank: Uint32Array,
    line: Uint32Array,
) -> Uint32Array {
    Uint32Array::new(analyze(&offsets, &neighbors, &file_rank, &line))
}

pub fn analyze(offsets: &[u32], neighbors: &[u32], file_rank: &[u32], line: &[u32]) -> Vec<u32> {
    let node_count = offsets.len().saturating_sub(1);
    let adjacent = |node: usize| &neighbors[offsets[node] as usize..offsets[node + 1] as usize];
    let mut output = vec![0u32];
    let mut component_count = 0u32;

    let mut visited = vec![false; node_count];
    let mut pending: Vec<u32> = Vec::new();
    let mut members: Vec<u32> = Vec::new();
    let mut tarjan = Tarjan::new(node_count);

    for start in 0..node_count {
        if visited[start] {
            continue;
        }
        members.clear();
        pending.push(start as u32);
        while let Some(current) = pending.pop() {
            let current = current as usize;
            if visited[current] {
                continue;
            }
            visited[current] = true;
            members.push(current as u32);
            for &neighbor in adjacent(current) {
                if !visited[neighbor as usize] {
                    pending.push(neighbor);
                }
            }
        }
        // Stable, like Array.prototype.sort: ties keep discovery order.
        members.sort_by_key(|&member| (file_rank[member as usize], line[member as usize]));

        output.push(members.len() as u32);
        output.extend_from_slice(&members);
        tarjan.articulation(&members, &adjacent, &mut output);
        component_count += 1;
    }

    output[0] = component_count;
    output
}

struct Tarjan {
    discovery: Vec<u32>,
    low: Vec<u32>,
    parent: Vec<u32>,
    child_count: Vec<u32>,
    subtree_size: Vec<u32>,
    separated: Vec<Vec<u32>>,
    frames: Vec<(u32, u32)>,
    impacts: Vec<[u32; 4]>,
}

impl Tarjan {
    fn new(node_count: usize) -> Self {
        Self {
            discovery: vec![UNSET; node_count],
            low: vec![0; node_count],
            parent: vec![UNSET; node_count],
            child_count: vec![0; node_count],
            subtree_size: vec![0; node_count],
            separated: vec![Vec::new(); node_count],
            frames: Vec::new(),
            impacts: Vec::new(),
        }
    }

    /// Appends `articulationCount, tieCount, ties...` for one connected component.
    fn articulation<'a>(
        &mut self,
        members: &[u32],
        adjacent: &impl Fn(usize) -> &'a [u32],
        output: &mut Vec<u32>,
    ) {
        let size = members.len() as u32;
        let mut clock = 0u32;

        // A WCC is connected, but iterate like the TypeScript code in case it is ever not.
        for &root in members {
            let root = root as usize;
            if self.discovery[root] != UNSET {
                continue;
            }
            clock += 1;
            self.visit(root, UNSET, clock);
            self.frames.push((root as u32, 0));

            while let Some(&mut (node, ref mut next)) = self.frames.last_mut() {
                let node = node as usize;
                let neighbors = adjacent(node);
                if (*next as usize) < neighbors.len() {
                    let neighbor = neighbors[*next as usize];
                    *next += 1;
                    if neighbor == self.parent[node] {
                        continue;
                    }
                    let neighbor = neighbor as usize;
                    if self.discovery[neighbor] == UNSET {
                        clock += 1;
                        self.visit(neighbor, node as u32, clock);
                        self.child_count[node] += 1;
                        self.frames.push((neighbor as u32, 0));
                    } else {
                        self.low[node] = self.low[node].min(self.discovery[neighbor]);
                    }
                    continue;
                }

                self.frames.pop();
                let parent = self.parent[node];
                if parent == UNSET {
                    continue;
                }
                let parent = parent as usize;
                let node_size = self.subtree_size[node];
                self.subtree_size[parent] += node_size;
                self.low[parent] = self.low[parent].min(self.low[node]);
                // Root children are split parts unconditionally; non-root parents only when separated.
                if self.parent[parent] == UNSET || self.low[node] >= self.discovery[parent] {
                    self.separated[parent].push(node_size);
                }
            }
        }

        self.impacts.clear();
        for &member in members {
            let member = member as usize;
            let is_root = self.parent[member] == UNSET;
            let parts = &mut self.separated[member];
            let is_articulation = if is_root {
                self.child_count[member] > 1
            } else {
                !parts.is_empty()
            };
            if is_articulation {
                if !is_root {
                    let separated_total: u32 = parts.iter().sum();
                    let remainder = size as i64 - 1 - separated_total as i64;
                    if remainder > 0 {
                        parts.push(remainder as u32);
                    }
                }
                let largest = parts.iter().copied().max().unwrap_or(0);
                let impact = (size as i64 - 1 - largest as i64).max(0) as u32;
                self.impacts.push([member as u32, impact, parts.len() as u32, largest]);
            }
            // Reset per-node state for later components.
            parts.clear();
            self.discovery[member] = UNSET;
            self.parent[member] = UNSET;
            self.child_count[member] = 0;
        }

        output.push(self.impacts.len() as u32);
        let best = self.impacts.iter().map(|impact| (impact[1], impact[2])).max();
        let tie_start = output.len();
        output.push(0);
        if let Some(best) = best {
            for impact in self.impacts.iter().filter(|impact| (impact[1], impact[2]) == best) {
                output.extend_from_slice(impact);
                output[tie_start] += 1;
            }
        }
    }

    fn visit(&mut self, node: usize, parent: u32, clock: u32) {
        self.discovery[node] = clock;
        self.low[node] = clock;
        self.parent[node] = parent;
        self.child_count[node] = 0;
        self.subtree_size[node] = 1;
        self.separated[node].clear();
    }
}

#[cfg(test)]
mod tests {
    use super::analyze;

    fn csr(node_count: usize, edges: &[(u32, u32)]) -> (Vec<u32>, Vec<u32>) {
        let mut lists = vec![Vec::new(); node_count];
        for &(left, right) in edges {
            lists[left as usize].push(right);
            lists[right as usize].push(left);
        }
        let mut offsets = vec![0];
        let mut neighbors = Vec::new();
        for list in lists {
            neighbors.extend(list);
            offsets.push(neighbors.len() as u32);
        }
        (offsets, neighbors)
    }

    #[test]
    fn path_has_middle_articulation_point() {
        // 0 - 1 - 2 plus an isolated node 3.
        let (offsets, neighbors) = csr(4, &[(0, 1), (1, 2)]);
        let output = analyze(&offsets, &neighbors, &[0, 0, 0, 1], &[1, 2, 3, 1]);
        assert_eq!(output, vec![
            2, // components
            3, 0, 1, 2, 1, 1, 1, 1, 2, 1, // path: AP node 1, impact 1, 2 parts, largest 1
            1, 3, 0, 0, // isolated node: no articulation points
        ]);
    }

    #[test]
    fn cycle_has_no_articulation_points_and_star_ties() {
        // Triangle 0-1-2 and star 3 - {4, 5, 6}.
        let (offsets, neighbors) = csr(7, &[(0, 1), (1, 2), (2, 0), (3, 4), (3, 5), (3, 6)]);
        let output = analyze(&offsets, &neighbors, &[0; 7], &[1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(output, vec![
            2,
            3, 0, 1, 2, 0, 0,
            4, 3, 4, 5, 6, 1, 1, 3, 2, 3, 1, // root with 3 children: impact 2, 3 parts, largest 1
        ]);
    }

    #[test]
    fn members_sort_stably_by_file_rank_then_line() {
        let (offsets, neighbors) = csr(3, &[(0, 1), (1, 2)]);
        let output = analyze(&offsets, &neighbors, &[1, 0, 0], &[1, 5, 5]);
        // Discovery order 0, 1, 2; nodes 1 and 2 tie on (0, 5) and keep discovery order.
        assert_eq!(&output[..5], &[1, 3, 1, 2, 0]);
    }
}
