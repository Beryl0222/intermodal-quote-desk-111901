import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';

const data = await readInputs();

test("供应回复、询价端点和换装资料可以回查", () => {
  const ids = new Set(data.mail.map(message => message.id));
  for (const message of data.mail.filter(item => item.replyTo)) assert.ok(ids.has(message.replyTo));
  const nodes = new Set(data.network.flatMap(segment => [segment.from, segment.to]));
  for (const request of data.requests) assert.ok(nodes.has(request.from) && nodes.has(request.to));
  for (const entry of data.transfers) {
    assert.equal(data.network.find(segment => segment.id === entry.inbound).to, entry.site);
    assert.equal(data.network.find(segment => segment.id === entry.outbound).from, entry.site);
  }
  assert.ok(data.allotments.every(allotment => data.mail.some(message => message.body.includes(allotment.id))));
});
