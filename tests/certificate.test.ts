import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CERTIFICATE_TRUST_GUIDANCE,
  certificatePaths,
  createCertificateStore,
  generateSelfSignedCertificate,
  isIpv4,
} from '../src/main/services/certificate.ts';
import { integer, objectIdentifier, toPem, utcTime } from '../src/main/services/der.ts';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'ep-cert-'));

// ── DER encoder ─────────────────────────────────────────────────────────────────

test('OIDs encode to the known byte sequences', () => {
  // ecdsa-with-SHA256. Verified against the published encoding rather than round-tripping
  // our own encoder against itself.
  assert.deepEqual(
    [...objectIdentifier('1.2.840.10045.4.3.2')],
    [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02],
  );
  // 2.5.4.3 (commonName) — the multi-byte arc path is exercised above; this covers the
  // packed first two arcs.
  assert.deepEqual([...objectIdentifier('2.5.4.3')], [0x06, 0x03, 0x55, 0x04, 0x03]);
});

test('an invalid OID is rejected rather than silently mis-encoded', () => {
  for (const bad of ['1', '', 'a.b.c', '1.-2.3']) {
    assert.throws(() => objectIdentifier(bad), /invalid OID/);
  }
});

test('positive INTEGERs get a leading zero when the high bit is set', () => {
  // Without this a serial number reads as negative and some validators reject the cert.
  assert.deepEqual([...integer(Uint8Array.of(0x80))], [0x02, 0x02, 0x00, 0x80]);
  assert.deepEqual([...integer(Uint8Array.of(0x7f))], [0x02, 0x01, 0x7f]);
  assert.deepEqual([...integer(2)], [0x02, 0x01, 0x02]);
  assert.deepEqual([...integer(0)], [0x02, 0x01, 0x00]);
});

test('UTCTime refuses dates X.509 says it cannot represent', () => {
  assert.doesNotThrow(() => utcTime(new Date('2026-09-27T10:00:00Z')));
  assert.throws(() => utcTime(new Date('2050-01-01T00:00:00Z')), /GeneralizedTime/);
});

test('UTCTime formats as YYMMDDHHMMSSZ', () => {
  const bytes = utcTime(new Date('2026-09-27T10:05:09Z'));
  const text = String.fromCharCode(...bytes.subarray(2));
  assert.equal(text, '260927100509Z');
});

test('PEM wrapping is 64 columns with the right label', () => {
  const pem = toPem(new Uint8Array(100).fill(0xab), 'CERTIFICATE');
  const lines = pem.trim().split('\n');
  assert.equal(lines[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(lines[lines.length - 1], '-----END CERTIFICATE-----');
  for (const line of lines.slice(1, -1)) assert.ok(line.length <= 64);
});

// ── certificate generation, validated by Node's own X.509 parser ────────────────

test("NODE'S OWN PARSER ACCEPTS OUR CERTIFICATE", () => {
  // The real proof that the hand-rolled DER is correct: a parser we did not write reads it.
  const material = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'] });
  const parsed = new X509Certificate(material.certificatePem);

  assert.match(parsed.subject, /Exceptionel Wireless Camera/);
  assert.equal(parsed.subject, parsed.issuer, 'self-signed means subject equals issuer');
  assert.equal(parsed.ca, false, 'it must not claim to be a CA');
});

test('the certificate verifies against its own public key', () => {
  const material = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'] });
  const parsed = new X509Certificate(material.certificatePem);
  assert.equal(parsed.verify(parsed.publicKey), true);
});

test('SUBJECT ALT NAMES carry the LAN IPs — browsers match on SAN, not CN', () => {
  // A certificate with a correct CN but no SAN is rejected by every modern browser, which
  // would make the phone page unreachable for a reason nothing in the UI could explain.
  const material = generateSelfSignedCertificate({
    ipAddresses: ['192.168.1.100', '10.0.0.5'],
    hostnames: ['exceptionel.local'],
  });
  const san = new X509Certificate(material.certificatePem).subjectAltName ?? '';

  assert.match(san, /IP Address:192\.168\.1\.100/);
  assert.match(san, /IP Address:10\.0\.0\.5/);
  assert.match(san, /DNS:exceptionel\.local/);
  assert.match(san, /DNS:localhost/, 'localhost is always included for self health checks');
});

test('the validity window starts slightly in the past to tolerate phone clock skew', () => {
  const now = new Date('2026-09-27T10:00:00.000Z');
  const material = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'], now, days: 30 });

  assert.ok(Date.parse(material.validFrom) < now.getTime(), 'a phone with a slow clock must still connect');
  assert.equal(
    Math.round((Date.parse(material.validTo) - now.getTime()) / 86_400_000),
    30,
  );
});

test('each certificate is unique — no fixed serial or reused key', () => {
  const a = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'] });
  const b = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'] });
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(new X509Certificate(a.certificatePem).serialNumber, new X509Certificate(b.certificatePem).serialNumber);
});

test('the private key is a usable PKCS#8 EC key and is NOT in the certificate', () => {
  const material = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100'] });
  assert.match(material.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(material.certificatePem, /PRIVATE KEY/, 'the cert must never carry the key');
});

test('generation refuses when no address a PHONE can reach was supplied', () => {
  // A certificate valid only for localhost would be minted happily and then fail TLS on the
  // phone, so the real problem — no usable LAN interface — must surface here instead.
  assert.throws(() => generateSelfSignedCertificate({ ipAddresses: [], hostnames: [] }), /LAN IP/);
  assert.throws(
    () => generateSelfSignedCertificate({ ipAddresses: ['garbage', '999.1.1.1'] }),
    /LAN IP/,
    'addresses that fail validation do not count as usable',
  );
  // A real hostname is enough on its own, for a future mDNS name.
  assert.doesNotThrow(() => generateSelfSignedCertificate({ ipAddresses: [], hostnames: ['ep.local'] }));
});

test('non-IPv4 strings are filtered rather than corrupting the SAN', () => {
  assert.equal(isIpv4('192.168.1.100'), true);
  assert.equal(isIpv4('256.1.1.1'), false);
  assert.equal(isIpv4('192.168.1'), false);
  assert.equal(isIpv4('::1'), false, 'IPv6 needs a different GeneralName tag');
  assert.equal(isIpv4('not-an-ip'), false);

  // A bad address must not silently become 4 garbage bytes in the certificate.
  const material = generateSelfSignedCertificate({ ipAddresses: ['192.168.1.100', 'garbage', '::1'] });
  const san = new X509Certificate(material.certificatePem).subjectAltName ?? '';
  assert.doesNotMatch(san, /garbage/);
  assert.match(san, /192\.168\.1\.100/);
});

// ── persistence ─────────────────────────────────────────────────────────────────

test('the store generates once and reuses thereafter', () => {
  const dir = scratch();
  try {
    const store = createCertificateStore(certificatePaths(dir));
    const first = store.ensure({ ipAddresses: ['192.168.1.100'] });
    const second = store.ensure({ ipAddresses: ['192.168.1.100'] });
    assert.equal(first.fingerprint, second.fingerprint, 'a restart must not re-mint needlessly');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NOTHING IS COMMITTED — material lives in the app data directory', () => {
  const dir = scratch();
  try {
    const paths = certificatePaths(dir);
    createCertificateStore(paths).ensure({ ipAddresses: ['192.168.1.100'] });
    assert.ok(existsSync(paths.certificatePath));
    assert.ok(existsSync(paths.privateKeyPath));
    assert.ok(paths.privateKeyPath.startsWith(dir), 'must be under app data, never the repo');
    assert.match(readFileSync(paths.privateKeyPath, 'utf8'), /BEGIN PRIVATE KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A CERTIFICATE IS RE-MINTED WHEN THE LAN ADDRESS CHANGES', () => {
  // DHCP hands out a new lease and the old certificate no longer covers the address the
  // server binds, so the phone would fail TLS with nothing explaining why.
  const dir = scratch();
  try {
    const store = createCertificateStore(certificatePaths(dir));
    const first = store.ensure({ ipAddresses: ['192.168.1.100'] });
    const second = store.ensure({ ipAddresses: ['192.168.1.55'] });

    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.match(new X509Certificate(second.certificatePem).subjectAltName ?? '', /192\.168\.1\.55/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an expiring certificate is replaced a week early', () => {
  const dir = scratch();
  try {
    const store = createCertificateStore(certificatePaths(dir));
    const now = new Date('2026-01-01T00:00:00.000Z');
    const first = store.ensure({ ipAddresses: ['192.168.1.100'], days: 10, now });

    // Three days short of expiry: inside the one-week renewal margin.
    const later = new Date(now.getTime() + 7 * 86_400_000);
    const second = store.ensure({ ipAddresses: ['192.168.1.100'], now: later });

    assert.notEqual(first.fingerprint, second.fingerprint, 'must not expire mid-week during a service');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt certificate file is regenerated rather than crashing the feature', () => {
  const dir = scratch();
  try {
    const paths = certificatePaths(dir);
    const store = createCertificateStore(paths);
    store.ensure({ ipAddresses: ['192.168.1.100'] });

    // Simulate a truncated write or disk corruption.
    writeFileSync(paths.certificatePath, 'not a certificate', 'utf8');
    assert.equal(store.load(), null, 'unreadable material reports as absent');

    const recovered = store.ensure({ ipAddresses: ['192.168.1.100'] });
    assert.ok(new X509Certificate(recovered.certificatePem));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear removes both files', () => {
  const dir = scratch();
  try {
    const paths = certificatePaths(dir);
    const store = createCertificateStore(paths);
    store.ensure({ ipAddresses: ['192.168.1.100'] });
    store.clear();
    assert.equal(existsSync(paths.certificatePath), false);
    assert.equal(existsSync(paths.privateKeyPath), false);
    assert.equal(store.load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('load on an empty directory returns null rather than throwing', () => {
  const dir = scratch();
  try {
    assert.equal(createCertificateStore(certificatePaths(dir)).load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── operator guidance ───────────────────────────────────────────────────────────

test('the trust warning is explained in advance, per platform', () => {
  // The phone WILL warn. Treating that as onboarding rather than an error is the difference
  // between a feature that works and one the operator abandons.
  assert.match(CERTIFICATE_TRUST_GUIDANCE.headline, /security warning/i);
  assert.ok(CERTIFICATE_TRUST_GUIDANCE.steps.some((step) => /iPhone/i.test(step)));
  assert.ok(CERTIFICATE_TRUST_GUIDANCE.steps.some((step) => /Android/i.test(step)));
  assert.match(CERTIFICATE_TRUST_GUIDANCE.reassurance, /never uploaded/i);
});
