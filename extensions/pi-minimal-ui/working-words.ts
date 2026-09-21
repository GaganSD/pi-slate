export const WORKING_WORDS = [
  "Crafting",
  "Mining",
  "Farming",
  "Building",
  "Pondering",
  "Yeeting",
  "Manifesting",
  "Transmuting",
] as const;

export function createWordPicker(
  words: readonly string[] = WORKING_WORDS,
  rng: () => number = Math.random,
) {
  if (words.length === 0) throw new Error("createWordPicker: empty word list");
  let bag: string[] = [];
  let last: string | undefined;

  return {
    next(): string {
      if (bag.length === 0) {
        bag = words.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [bag[i], bag[j]] = [bag[j]!, bag[i]!];
        }
        if (bag.length > 1 && bag[bag.length - 1] === last) {
          [bag[bag.length - 1], bag[0]] = [bag[0]!, bag[bag.length - 1]!];
        }
      }
      last = bag.pop()!;
      return last;
    },
  };
}
