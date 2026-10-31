import test from 'node:test';
import assert from 'node:assert/strict';
import { drawRecipients } from '../draw.mjs';

test('1,000 randomized draws satisfy every giving and receiving constraint', () => {
  const ids = ['a','b','c','d','e','f'];
  for (let n=0;n<1000;n++) {
    const draw=drawRecipients(ids), received=Object.fromEntries(ids.map(id=>[id,0]));
    for (const id of ids) {
      assert.equal(draw[id].length,2); assert.equal(new Set(draw[id]).size,2);
      assert.ok(!draw[id].includes(id));
      for (const recipient of draw[id]) received[recipient]++;
    }
    assert.deepEqual(Object.values(received),[2,2,2,2,2,2]);
  }
});
test('rejects incomplete or duplicate participant lists', () => {
  assert.throws(()=>drawRecipients(['a','b']));
  assert.throws(()=>drawRecipients(['a','b','c','d','e','e']));
});
