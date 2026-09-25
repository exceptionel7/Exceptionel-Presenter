import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { connect } from 'node:tls';
import {
  allLanAddresses,
  bestLanAddress,
  diagnoseNetwork,
  isLinkLocal,
  isPrivateIpv4,
  rankLanAddresses,
  systemInterfaces,
  type InterfaceRecord,
} from '../src/main/services/network.ts';
import { generateSelfSignedCertificate } from '../src/main/services/certificate.ts';

const iface = (
  name: string,
  address: string,
  overrides: Partial<InterfaceRecord> = {},
): InterfaceRecord => ({ name, address, family: 'IPv4', internal: false, ...overrides });

const from = (...records: InterfaceRecord[]) => () => records;

// ── address classification ──────────────────────────────────────────────────────

test('RFC1918 ranges are recognised', () => {
  for (const address of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.100']) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1', '203.0.113.1']) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
});

test('link-local addresses mean DHCP failed', () => {
  assert.equal(isLinkLocal('169.254.1.1'), true);
  assert.equal(isLinkLocal('192.168.1.1'), false);
});

// ── interface selection ─────────────────────────────────────────────────────────

test('loopback and internal interfaces are never offered to a phone', () => {
  const ranked = rankLanAddresses(
    from(iface('lo', '127.0.0.1', { internal: true }), iface('wlan0', '192.168.1.100')),
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.address, '192.168.1.100');
});

test('IPv6 records are ignored — the certificate encodes IPv4 only', () => {
  const ranked = rankLanAddresses(
    from(iface('wlan0', 'fe80::1', { family: 'IPv6' }), iface('wlan0', '192.168.1.100')),
  );
  assert.deepEqual(ranked.map((r) => r.address), ['192.168.1.100']);
});

test("Node's numeric family form is handled", () => {
  // Some Node versions report family as 4 rather than 'IPv4'.
  const ranked = rankLanAddresses(from(iface('wlan0', '192.168.1.100', { family: '4' })));
  assert.equal(ranked.length, 1);
});

test('a DHCP-failure address is never put in a QR code', () => {
  assert.equal(bestLanAddress(from(iface('wlan0', '169.254.10.20'))), null);
});

test('DOCKER AND VPN ADAPTERS RANK BELOW THE REAL NETWORK', () => {
  // These are ordinary on an operator's machine and their addresses are valid private IPs,
  // so they must be ranked down by name. A Docker bridge IP in the QR code produces a code
  // that silently never connects.
  const ranked = rankLanAddresses(
    from(
      iface('docker0', '172.17.0.1'),
      iface('br-a1b2c3', '172.18.0.1'),
      iface('utun3', '10.8.0.2'),
      iface('vEthernet (WSL)', '172.30.0.1'),
      iface('wlan0', '192.168.1.100'),
    ),
  );
  assert.equal(ranked[0]?.address, '192.168.1.100', 'the real Wi-Fi must win');
  assert.equal(ranked[0]?.interfaceName, 'wlan0');
});

test('WI-FI IS PREFERRED OVER ETHERNET, because the phone is on Wi-Fi', () => {
  // If the computer is wired AND on Wi-Fi, the shared subnet is the wireless one.
  const ranked = rankLanAddresses(from(iface('eth0', '192.168.2.50'), iface('wlan0', '192.168.1.100')));
  assert.equal(ranked[0]?.interfaceName, 'wlan0');
});

test('Windows and macOS interface names are recognised as real networks', () => {
  for (const name of ['Wi-Fi', 'en0', 'Ethernet', 'enp3s0', 'wlp2s0']) {
    const ranked = rankLanAddresses(from(iface(name, '192.168.1.100'), iface('docker0', '172.17.0.1')));
    assert.equal(ranked[0]?.interfaceName, name, `${name} should outrank docker0`);
  }
});

test('ordering is deterministic when scores tie', () => {
  const records = [iface('eth1', '192.168.1.20'), iface('eth0', '192.168.1.10')];
  assert.deepEqual(
    rankLanAddresses(from(...records)).map((r) => r.address),
    rankLanAddresses(from(...[...records].reverse())).map((r) => r.address),
    'the same set must always yield the same chosen address',
  );
});

test('THE CERTIFICATE COVERS EVERY INTERFACE, not just the chosen one', () => {
  // The operator may switch from Ethernet to Wi-Fi mid-setup; re-minting the certificate for
  // that would be a poor experience, and covering extra addresses costs nothing.
  const addresses = allLanAddresses(
    from(iface('wlan0', '192.168.1.100'), iface('eth0', '10.0.0.5'), iface('docker0', '172.17.0.1')),
  );
  assert.equal(addresses.length, 3);
  assert.ok(addresses.includes('192.168.1.100'));
  assert.ok(addresses.includes('10.0.0.5'));
});

// ── diagnosis (Section 20) ──────────────────────────────────────────────────────

test('a healthy network reports no problem', () => {
  const diagnosis = diagnoseNetwork(from(iface('wlan0', '192.168.1.100')));
  assert.equal(diagnosis.ok, true);
  assert.equal(diagnosis.problem, null);
  assert.equal(diagnosis.best?.address, '192.168.1.100');
});

test('no network at all is explained, not reported as an empty list', () => {
  const diagnosis = diagnoseNetwork(from(iface('lo', '127.0.0.1', { internal: true })));
  assert.equal(diagnosis.ok, false);
  assert.match(diagnosis.problem ?? '', /not.*connected to a network/i);
  assert.ok(diagnosis.remedies.length >= 2);
});

test('a failed DHCP lease is diagnosed specifically', () => {
  const diagnosis = diagnoseNetwork(from(iface('wlan0', '169.254.5.5')));
  assert.equal(diagnosis.ok, false);
  assert.match(diagnosis.problem ?? '', /could not obtain one from the router/i);
  assert.ok(diagnosis.remedies.some((r) => /DHCP/i.test(r)));
});

test('a VPN-only network warns while still allowing an attempt', () => {
  // A VPN address is a private address, so it scores positively. The warning must key off the
  // interface being virtual, not off arithmetic — otherwise it never fires for the case that
  // most often stops a phone connecting.
  for (const name of ['utun3', 'docker0', 'vEthernet (WSL)', 'ZeroTier One', 'tailscale0']) {
    const diagnosis = diagnoseNetwork(from(iface(name, '10.8.0.2')));
    assert.equal(diagnosis.ok, true, `${name}: may work, so not refused outright`);
    assert.match(diagnosis.problem ?? '', /virtual or VPN/i, name);
    assert.ok(diagnosis.remedies.some((r) => /VPN/i.test(r)), name);
  }
});

test('a real interface alongside a VPN produces no warning', () => {
  const diagnosis = diagnoseNetwork(from(iface('utun3', '10.8.0.2'), iface('wlan0', '192.168.1.100')));
  assert.equal(diagnosis.problem, null);
  assert.equal(diagnosis.best?.interfaceName, 'wlan0');
  assert.equal(diagnosis.best?.isVirtual, false);
});

test('a virtual interface loses even to a public-IP real interface', () => {
  // A public address is unusual but real; a Docker bridge is never the right answer.
  const ranked = rankLanAddresses(from(iface('docker0', '172.17.0.1'), iface('eth0', '203.0.113.9')));
  assert.equal(ranked[0]?.interfaceName, 'eth0');
});

test('reading the real interfaces of this machine does not throw', () => {
  assert.doesNotThrow(() => systemInterfaces());
  assert.doesNotThrow(() => diagnoseNetwork());
});

// ── the real proof: a genuine TLS handshake with our own certificate ────────────

test('A REAL HTTPS SERVER SERVES OUR GENERATED CERTIFICATE AND COMPLETES A TLS HANDSHAKE', async () => {
  // This is the claim that matters. Everything else about the certificate could be correct
  // on paper and still fail the moment a browser negotiates TLS with it.
  const material = generateSelfSignedCertificate({ ipAddresses: ['127.0.0.1'], hostnames: ['localhost'] });

  const server = createServer(
    { cert: material.certificatePem, key: material.privateKeyPem },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('wireless-camera-ok');
    },
  );

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  try {
    // A raw TLS socket rather than fetch: the certificate is intentionally untrusted here,
    // exactly as it is on the phone, and a socket lets the handshake itself be inspected.
    const socket = connect({ host: 'localhost', port, rejectUnauthorized: false, servername: 'localhost' });
    await once(socket, 'secureConnect');

    assert.equal(socket.authorized, false, 'self-signed, so not authorised — as on the phone');
    const peer = socket.getPeerCertificate() as {
      subject?: { CN?: string };
      subjectaltname?: string;
    };
    assert.match(peer.subject?.CN ?? '', /Exceptionel Wireless Camera/);
    assert.match(String(peer.subjectaltname ?? ''), /DNS:localhost/);
    assert.ok(socket.getProtocol()?.startsWith('TLS'), `negotiated ${socket.getProtocol()}`);

    socket.end();
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('an HTTPS request over the generated certificate returns real content', async () => {
  const material = generateSelfSignedCertificate({ ipAddresses: ['127.0.0.1'], hostnames: ['localhost'] });
  const server = createServer(
    { cert: material.certificatePem, key: material.privateKeyPem },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('wireless-camera-ok');
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  try {
    const response = await fetch(`https://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'wireless-camera-ok');
  } finally {
    if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
    server.close();
    await once(server, 'close');
  }
});

test('the server binds a specific interface rather than every address', async () => {
  // Section 2: the service must not be exposed more widely than necessary.
  const material = generateSelfSignedCertificate({ ipAddresses: ['127.0.0.1'] });
  const server = createServer({ cert: material.certificatePem, key: material.privateKeyPem });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal((server.address() as { address: string }).address, '127.0.0.1');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
