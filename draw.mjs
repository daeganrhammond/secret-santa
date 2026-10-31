import { randomInt } from 'node:crypto';

// Rejection sampling gives every valid labelled assignment the same chance.
export function drawRecipients(ids) {
  if (ids.length !== 6 || new Set(ids).size !== 6) throw new Error('Exactly six distinct participants are required.');
  const shuffle = () => {
    const result = [...ids];
    for (let i = result.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  for (;;) {
    const first = shuffle(), second = shuffle();
    if (ids.every((id, i) => id !== first[i] && id !== second[i] && first[i] !== second[i])) {
      return Object.fromEntries(ids.map((id, i) => [id, [first[i], second[i]]]));
    }
  }
}
