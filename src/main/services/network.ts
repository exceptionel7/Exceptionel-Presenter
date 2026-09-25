/**
 * EXCEPTIONEL PRESENTER — local network interface discovery (Section 4).
 *
 * The phone needs the computer's LAN address. `localhost` is meaningless from another device,
 * and a machine typically has several interfaces — Wi-Fi, Ethernet, VPN adapters, Docker
 * bridges, VirtualBox host-only networks — most of which a phone cannot reach.
 *
 * Choosing wrong is not a harmless mistake: the QR code encodes this address, so a Docker
 * bridge IP produces a QR code that silently never connects.
 *
 * `readInterfaces` is injected so the selection logic is testable without real hardware.
 */

import { networkInterfaces } from 'node:os';
import { isIpv4 } from './certificate.ts';

export interface InterfaceRecord {
  name: string;
  address: string;
  family: string;
  internal: boolean;
  netmask?: string;
}

export interface LanAddress {
  address: string;
  interfaceName: string;
  /** Higher is better. Exposed so the UI can explain why an address was chosen. */
  score: number;
  /** True for RFC1918 ranges, which is what a church Wi-Fi hands out. */
  isPrivate: boolean;
  /**
   * True when the interface NAME looks like a VPN, Docker bridge or hypervisor adapter.
   *
   * Tracked as its own fact rather than inferred from `score`: a VPN address is still a
   * private address, so it scores positively overall, and a score threshold would silently
   * fail to warn about exactly the case that most often breaks a phone connection.
   */
  isVirtual: boolean;
}

export type ReadInterfaces = () => InterfaceRecord[];

export const systemInterfaces: ReadInterfaces = () => {
  const out: InterfaceRecord[] = [];
  for (const [name, records] of Object.entries(networkInterfaces())) {
    for (const record of records ?? []) {
      out.push({
        name,
        address: record.address,
        family: String(record.family),
        internal: record.internal,
        ...(record.netmask ? { netmask: record.netmask } : {}),
      });
    }
  }
  return out;
};

/**
 * Interface names that are almost never what a phone should connect to.
 *
 * These are ordinary on a media operator's machine: a VPN for the church office, Docker if
 * anyone has developed on it, Hyper-V on Windows. Their addresses look like perfectly valid
 * private IPs, which is exactly why they have to be ranked down explicitly rather than
 * filtered by address shape.
 */
const DEPRIORITISED_PATTERNS: readonly RegExp[] = [
  /^(docker|br-|veth)/i,
  /^(vbox|vmnet|vmware)/i,
  /(virtual|hyper-v|vethernet)/i,
  /^(tun|tap|wg|utun|ppp|zt)/i,
  /(vpn|tailscale|zerotier)/i,
  /^(lo|loopback)/i,
];

/** Names that usually ARE the real network. */
const PREFERRED_PATTERNS: readonly RegExp[] = [
  /^(wlan|wlp|wifi|wi-fi)/i,
  /^en[0-9]/i, // macOS Wi-Fi/Ethernet
  /^eth[0-9]/i,
  /^(enp|eno|ens)/i,
  /ethernet/i,
];

export function isPrivateIpv4(address: string): boolean {
  if (!isIpv4(address)) return false;
  const [a = 0, b = 0] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 169.254.x.x means DHCP failed. Such an address is worse than useless in a QR code. */
export const isLinkLocal = (address: string): boolean => address.startsWith('169.254.');

/**
 * Ranks every usable IPv4 interface, best first.
 *
 * Wi-Fi is preferred over Ethernet because the phone is on Wi-Fi: if the computer is wired
 * and also on Wi-Fi, the Wi-Fi subnet is the one both devices share.
 */
export function rankLanAddresses(read: ReadInterfaces = systemInterfaces): LanAddress[] {
  const candidates: LanAddress[] = [];

  for (const record of read()) {
    // Node reports either 'IPv4' or 4 depending on version.
    const isIpv4Family = record.family === 'IPv4' || record.family === '4';
    if (!isIpv4Family || record.internal || !isIpv4(record.address)) continue;
    if (isLinkLocal(record.address)) continue;

    const isVirtual = DEPRIORITISED_PATTERNS.some((pattern) => pattern.test(record.name));

    let score = 0;
    if (isPrivateIpv4(record.address)) score += 100;
    if (PREFERRED_PATTERNS.some((pattern) => pattern.test(record.name))) score += 40;
    if (isVirtual) score -= 200; // must lose to any real interface, even a public-IP one
    // Wi-Fi edges out Ethernet, since the phone is necessarily wireless.
    if (/^(wlan|wlp|wifi|wi-fi)/i.test(record.name)) score += 10;

    candidates.push({
      address: record.address,
      interfaceName: record.name,
      score,
      isPrivate: isPrivateIpv4(record.address),
      isVirtual,
    });
  }

  return candidates.sort(
    (a, b) => b.score - a.score || a.address.localeCompare(b.address),
  );
}

/** The single address to put in the QR code, or null when there is no usable network. */
export const bestLanAddress = (read: ReadInterfaces = systemInterfaces): LanAddress | null =>
  rankLanAddresses(read)[0] ?? null;

/**
 * Every address the certificate should cover.
 *
 * All of them, not just the best one: the operator may be on Ethernet while the phone is on
 * Wi-Fi, and re-minting the certificate because they switched interface would be a poor
 * experience. Deprioritised interfaces are still included — covering them costs nothing and
 * avoids a TLS failure if the chosen address turns out to be wrong.
 */
export const allLanAddresses = (read: ReadInterfaces = systemInterfaces): string[] =>
  rankLanAddresses(read).map((candidate) => candidate.address);

export interface NetworkDiagnosis {
  ok: boolean;
  best: LanAddress | null;
  all: LanAddress[];
  /** Operator-facing explanation when no usable address exists. */
  problem: string | null;
  remedies: string[];
}

/** Section 20: when there is no usable network, say what to do about it. */
export function diagnoseNetwork(read: ReadInterfaces = systemInterfaces): NetworkDiagnosis {
  const all = rankLanAddresses(read);
  const raw = read();
  const best = all[0] ?? null;

  if (best) {
    // Checked on `isVirtual`, not on the score. A VPN address is still an RFC1918 address, so
    // it scores positively; keying the warning off the score meant it never fired for exactly
    // the case that most often stops a phone from connecting.
    if (best.isVirtual) {
      return {
        ok: true,
        best,
        all,
        problem: `Only a virtual or VPN network adapter ("${best.interfaceName}") was found.`,
        remedies: [
          'Connect this computer to the same Wi-Fi network as the phone.',
          'Disconnect any VPN, which can prevent the phone from reaching this computer.',
          `If ${best.address} does not work, choose a different address in Settings.`,
        ],
      };
    }
    return { ok: true, best, all, problem: null, remedies: [] };
  }

  const hasLinkLocal = raw.some((record) => isLinkLocal(record.address));
  if (hasLinkLocal) {
    return {
      ok: false,
      best: null,
      all,
      problem: 'This computer has no network address — it could not obtain one from the router.',
      remedies: [
        'Reconnect to the Wi-Fi network.',
        'Check that the router is handing out addresses (DHCP).',
        'Restart the Wi-Fi adapter.',
      ],
    };
  }

  return {
    ok: false,
    best: null,
    all,
    problem: 'This computer does not appear to be connected to a network.',
    remedies: [
      'Connect to the same Wi-Fi network as the phone.',
      'A wired connection also works, as long as the phone is on Wi-Fi from the same router.',
      'Wireless Camera cannot work without a shared local network.',
    ],
  };
}
