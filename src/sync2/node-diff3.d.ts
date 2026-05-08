// Local type declaration. node-diff3 ships its types via package.json
// "exports", which tsconfig's moduleResolution: "node" can't resolve.
// Re-declaring just the surface sync2 uses keeps us off the upgrade
// treadmill that bumping moduleResolution would push.
declare module "node-diff3" {
  export interface MergeResult {
    conflict: boolean;
    result: string[];
  }
  export interface IMergeOptions {
    excludeFalseConflicts?: boolean;
    stringSeparator?: string | RegExp;
  }
  export function merge<T>(
    a: string | T[],
    o: string | T[],
    b: string | T[],
    options?: IMergeOptions,
  ): MergeResult;
}
