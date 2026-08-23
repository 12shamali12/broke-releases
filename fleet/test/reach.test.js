/**
 * How to reach fleetd from a phone.
 *
 * The bind stays on loopback, which is right — this API can message every
 * session you have. But loopback also means the phone app cannot reach it, and
 * someone who starts the daemon, opens their phone and sees nothing has no way
 * to know why. So the job of this module is to explain the ways in without
 * quietly widening anything, and most of what is tested is the refusal to
 * offer an address that will not work.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { displayHost, isReachableFromPhone, lanAddresses, reachOptions } from '../src/reach.js';

const iface = (address, over = {}) => ({ address, family: 'IPv4', internal: false, ...over });

test('loopback and internal addresses are never offered', () => {
  const found = lanAddresses({
    lo: [iface('127.0.0.1', { internal: true })],
    eth0: [iface('192.168.1.20')],
  });
  assert.deepEqual(found.map((f) => f.address), ['192.168.1.20']);
});

test('IPv6 is not offered, because typing one into a phone is not a plan', () => {
  const found = lanAddresses({ eth0: [{ address: 'fe80::1', family: 'IPv6', internal: false }] });
  assert.deepEqual(found, []);
});

test('a Docker or VM bridge is never offered', () => {
  // Offering 172.17.0.1 as "try this from your phone" is worse than offering
  // nothing: it looks like an answer, and the failure teaches you nothing.
  const found = lanAddresses({
    docker0: [iface('172.17.0.1')],
    'br-abc123': [iface('172.18.0.1')],
    vmnet1: [iface('192.168.56.1')],
    wlan0: [iface('192.168.1.20')],
  });
  assert.deepEqual(found.map((f) => f.address), ['192.168.1.20']);
});

test('a link-local address is never offered', () => {
  assert.deepEqual(lanAddresses({ eth0: [iface('169.254.10.1')] }), []);
});

test('Wi-Fi is offered before ethernet, because that is what the phone is on', () => {
  const found = lanAddresses({
    eth0: [iface('10.0.0.5')],
    wlan0: [iface('192.168.1.20')],
  });
  assert.equal(found[0].address, '192.168.1.20');
});

test('a numeric family, as older Node reports it, still works', () => {
  const found = lanAddresses({ en0: [{ address: '192.168.1.30', family: 4, internal: false }] });
  assert.deepEqual(found.map((f) => f.address), ['192.168.1.30']);
});

test('every option states what it costs, except the one that costs nothing', () => {
  const options = reachOptions({ port: 8787, interfaces: { wlan0: [iface('192.168.1.20')] } });
  const byKey = Object.fromEntries(options.map((o) => [o.key, o]));

  assert.equal(byKey.loopback.cost, null, 'staying on loopback costs nothing');
  assert.match(byKey.lan.cost, /network/, 'exposing to the LAN is a real decision');
  assert.match(byKey.tunnel.cost, /tunnel/);
});

test('the LAN option is unavailable, not fabricated, when there is no address', () => {
  const [, lan] = reachOptions({ interfaces: { lo: [iface('127.0.0.1', { internal: true })] } });
  assert.equal(lan.available, false);
  assert.equal(lan.url, null, 'never invent a URL that cannot work');
});

test('the tunnel is always available, because it does not depend on this machine', () => {
  const options = reachOptions({ interfaces: {} });
  assert.equal(options.find((o) => o.key === 'tunnel').available, true);
});

test('the port is carried into every URL offered', () => {
  const options = reachOptions({ port: 9999, interfaces: { wlan0: [iface('192.168.1.20')] } });
  for (const o of options) {
    if (o.url) assert.match(o.url, /:9999\//, `${o.key} ignored the port`);
  }
});

test('loopback is correctly reported as unreachable from a phone', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(isReachableFromPhone(host), false, host);
  }
  for (const host of ['0.0.0.0', '192.168.1.20']) {
    assert.equal(isReachableFromPhone(host), true, host);
  }
});

test('a bind address is not a URL you can open', () => {
  // fleetd printed "phone app http://0.0.0.0:8787/" whenever anyone followed
  // its own advice to use --host 0.0.0.0. Nothing can open that — not the
  // phone it was printed for, not the machine it was printed on — and it
  // fails with no hint about why.
  const nics = {
    eth0: [{ family: 'IPv4', address: '192.168.1.40', internal: false }],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  assert.equal(displayHost('0.0.0.0', nics), '192.168.1.40');
  assert.equal(displayHost('::', nics), '192.168.1.40', 'the v6 wildcard is the same mistake');

  // The substitute goes through the same filtering as everything else, so a
  // Docker bridge is never handed over as "try this from your phone".
  assert.notEqual(displayHost('0.0.0.0', nics), '172.17.0.1');

  // An explicit host is left alone, whatever it is.
  assert.equal(displayHost('127.0.0.1', nics), '127.0.0.1');
  assert.equal(displayHost('192.168.1.40', nics), '192.168.1.40');
});

test('a machine with no usable address still gets a URL that works somewhere', () => {
  // Loopback beats the wildcard: it works on this machine, which is more than
  // 0.0.0.0 manages anywhere.
  assert.equal(displayHost('0.0.0.0', { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), '127.0.0.1');
});
