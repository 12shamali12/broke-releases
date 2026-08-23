/**
 * How to actually open this from your phone.
 *
 * fleetd binds to loopback, which is right: the API can send messages to every
 * session you have, and the default should never be that anyone on the café
 * Wi-Fi can try. But loopback also means the phone app — the whole reason the
 * phone app exists — cannot reach it, and someone who starts the daemon, opens
 * their phone and sees nothing has no way to know why.
 *
 * So rather than widening the bind, this explains the three ways in, in the
 * order they should be tried, and says plainly what each one costs.
 */

import { networkInterfaces } from 'node:os';

/**
 * The address a phone on the same network would use.
 *
 * IPv4 only, non-internal, and Docker/VM bridges filtered out — offering
 * 172.17.0.1 as "try this from your phone" is worse than offering nothing,
 * because it looks like an answer.
 */
export function lanAddresses(interfaces = networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      // Node <18 reports a number for `family`; both spellings appear in the wild.
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (isVirtual(name, addr.address)) continue;
      found.push({ name, address: addr.address });
    }
  }
  // Wi-Fi first: it is what a phone is actually on.
  return found.sort((a, b) => rank(a.name) - rank(b.name));
}

function isVirtual(name, address) {
  if (/^(docker|br-|veth|virbr|vmnet|utun|tun|tap|zt|wg)/i.test(name)) return true;
  // Docker's default bridge range, and link-local, which no phone will route.
  if (/^172\.1[7-9]\./.test(address) || /^172\.2\d\./.test(address) || /^172\.3[01]\./.test(address)) return true;
  if (/^169\.254\./.test(address)) return true;
  return false;
}

function rank(name) {
  if (/^(wlan|wl|wi-?fi|en0)/i.test(name)) return 0;
  if (/^(eth|en|em)/i.test(name)) return 1;
  return 2;
}

/**
 * The three ways in, in the order to try them.
 *
 * Each carries what it costs, because "expose it to your network" and "run a
 * tunnel" are not the same decision and should not be presented as if they
 * were.
 */
export function reachOptions({ port = 8787, interfaces = networkInterfaces() } = {}) {
  const lan = lanAddresses(interfaces);

  return [
    {
      key: 'loopback',
      title: 'On this machine',
      url: `http://127.0.0.1:${port}/`,
      cost: null,
      available: true,
    },
    {
      key: 'lan',
      title: 'From your phone on the same Wi-Fi',
      url: lan.length ? `http://${lan[0].address}:${port}/` : null,
      // Stated rather than buried: this is a real change in who can try.
      // The command itself is shown by the caller; this is the consequence,
      // which is the part worth reading twice.
      cost: 'anything on your network can then reach the API. Pairing still gates it, but the door becomes visible.',
      available: lan.length > 0,
      detail: lan.length
        ? `${lan[0].name} · ${lan.length > 1 ? `${lan.length} addresses found` : 'one address found'}`
        : 'no non-virtual network address found',
    },
    {
      key: 'tunnel',
      title: 'From anywhere',
      url: null,
      // `detail` says what the option is and `cost` says what it takes — the
      // same order as the LAN entry above, and the order the caller prints
      // them in. These two were the other way round, so the screen read
      // "the only option that works off your network" before saying what the
      // option was.
      detail: 'a tunnel (Cloudflare Tunnel, Tailscale) in front of loopback — the only option that works off your network, and the only one to use on untrusted Wi-Fi',
      cost: 'one more service to install and keep running, with its operator in the path. In exchange the bind stays private and the tunnel adds its own authentication.',
      available: true,
    },
  ];
}

/** Whether the current bind can be reached from another device at all. */
export function isReachableFromPhone(host) {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

/**
 * The address to print, given the address we bound to.
 *
 * `0.0.0.0` answers "can a phone reach this" with yes and "where do I go"
 * with nothing at all — it is a bind, not a destination. Nothing can open it:
 * not the phone it was printed for, not the machine it was printed on. fleetd
 * printed exactly that as the URL to visit whenever anyone followed its own
 * advice to use `--host 0.0.0.0`, and the link simply failed.
 *
 * Falls back to loopback rather than to the wildcard, because a URL that works
 * on this machine only is still better than one that works nowhere.
 */
export function displayHost(host, interfaces = networkInterfaces()) {
  if (host !== '0.0.0.0' && host !== '::' && host !== '') return host;
  return lanAddresses(interfaces)[0]?.address ?? '127.0.0.1';
}
