import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListeningPorts } from './SandboxManager.js';

test('parseListeningPorts extracts listening TCP ports from procfs output', () => {
  const ports = parseListeningPorts(`  sl  local_address rem_address   st
   0: 0100007F:0BB8 00000000:0000 0A
   1: 00000000:13B1 00000000:0000 0A
   2: 00000000:1F90 00000000:0000 01`);

  assert.deepEqual(ports, [3000, 5041]);
});
