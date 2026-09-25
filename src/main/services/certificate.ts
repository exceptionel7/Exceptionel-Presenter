/**
 * EXCEPTIONEL PRESENTER — local certificate management for the Wireless Camera service.
 *
 * WHY A CERTIFICATE IS UNAVOIDABLE: browsers only grant `getUserMedia` in a secure context.
 * A phone opening `http://192.168.1.100:8443/camera` is refused the camera outright, with no
 * prompt and no way for the page to recover. So the signaling server must speak HTTPS even
 * though it never leaves the LAN.
 *
 * The certificate is generated on first use into the app data directory. Nothing is
 * committed to the repository and no private key is ever bundled (Section 3).
 *
 * HONEST LIMITATION: a self-signed certificate is not trusted by the phone, so the phone
 * shows a warning the first time. That is treated as a designed onboarding step, not an
 * error — see `CERTIFICATE_TRUST_GUIDANCE`. Getting a genuinely trusted certificate for a
 * private IP is not possible without either shipping a private key (unacceptable) or
 * requiring internet access and a domain (defeats the offline-first requirement).
 */

import { generateKeyPairSync, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bitString,
  boolean,
  concat,
  contextConstructed,
  contextPrimitive,
  integer,
  objectIdentifier,
  octetString,
  printableString,
  sequence,
  set,
  toPem,
  utcTime,
  type Der,
} from './der.ts';

export interface CertificateMaterial {
  certificatePem: string;
  privateKeyPem: string;
  /** SHA-256 fingerprint, shown on the pairing screen so the operator can match it. */
  fingerprint: string;
  validFrom: string;
  validTo: string;
  /** IPs and hostnames the certificate is valid for. */
  subjectAltNames: string[];
}

export interface GenerateOptions {
  /** LAN addresses the phone will use. Must include every interface the server binds. */
  ipAddresses: readonly string[];
  hostnames?: readonly string[];
  /** Validity window. Short-lived certs are re-minted automatically. */
  days?: number;
  now?: Date;
}

const OID = {
  commonName: '2.5.29.0'.replace('29.0', '4.3'), // 2.5.4.3
  organisation: '2.5.4.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

/**
 * Generates a self-signed P-256 certificate.
 *
 * ECDSA rather than RSA: far faster to generate (a church PC should not stall for seconds on
 * first launch) and universally supported by modern mobile browsers, which is the only client
 * that matters here.
 */
export function generateSelfSignedCertificate(options: GenerateOptions): CertificateMaterial {
  const now = options.now ?? new Date();
  const days = options.days ?? 365;

  const ipAddresses = [...new Set(options.ipAddresses)].filter(isIpv4);
  const requestedHostnames = [...new Set(options.hostnames ?? [])];

  // Checked BEFORE localhost is injected. A certificate valid only for localhost is useless
  // to a phone, so producing one silently would hide the real problem — that no usable LAN
  // interface was found — until TLS failed on the phone with nothing to explain it.
  if (ipAddresses.length === 0 && requestedHostnames.length === 0) {
    throw new Error(
      'a certificate needs at least one LAN IP address or hostname the phone can reach',
    );
  }

  // localhost is then always included so the desktop can health-check its own server without
  // depending on which interface happens to be up.
  const hostnames = [...new Set(['localhost', ...requestedHostnames])];

  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // SubjectPublicKeyInfo comes straight from Node, so the curve parameters are guaranteed
  // correct rather than hand-encoded.
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));

  const name = sequence(
    set(sequence(objectIdentifier(OID.organisation), printableString('Exceptionel Presenter'))),
    set(sequence(objectIdentifier(OID.commonName), printableString('Exceptionel Wireless Camera'))),
  );

  const notBefore = new Date(now.getTime() - 60_000); // tolerate small clock skew on the phone
  const notAfter = new Date(now.getTime() + days * 86_400_000);

  const signatureAlgorithm = sequence(objectIdentifier(OID.ecdsaWithSha256));

  const tbs = sequence(
    contextConstructed(0, integer(2)), // v3
    integer(serialNumber()),
    signatureAlgorithm,
    name, // issuer == subject for a self-signed certificate
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    spki,
    contextConstructed(
      3,
      sequence(
        // SAN is what browsers actually match against. A certificate whose CN says the right
        // thing but has no SAN is rejected by every modern browser.
        extension(OID.subjectAltName, false, subjectAltName(ipAddresses, hostnames)),
        extension(OID.basicConstraints, true, sequence(boolean(false))),
        // digitalSignature only: keyEncipherment is meaningless for ECDSA.
        extension(OID.keyUsage, true, bitString(Uint8Array.of(0x80), 7)),
        extension(OID.extKeyUsage, false, sequence(objectIdentifier(OID.serverAuth))),
      ),
    ),
  );

  // Node emits DER-encoded ECDSA signatures by default, which is exactly what X.509 wants
  // inside the signature BIT STRING.
  const signature = new Uint8Array(sign('sha256', tbs, privateKey));

  const certificateDer = sequence(tbs, signatureAlgorithm, bitString(signature));
  const certificatePem = toPem(certificateDer, 'CERTIFICATE');

  // Parse our own output before returning it. If the encoding is wrong, fail here rather
  // than when a phone silently refuses to connect.
  const parsed = new X509Certificate(certificatePem);
  if (!parsed.verify(createPublicKey(certificatePem))) {
    throw new Error('generated certificate failed self-verification');
  }

  return {
    certificatePem,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    fingerprint: formatFingerprint(parsed.fingerprint256),
    validFrom: notBefore.toISOString(),
    validTo: notAfter.toISOString(),
    subjectAltNames: [...ipAddresses, ...hostnames],
  };
}

function extension(oid: string, critical: boolean, value: Der): Der {
  // The DEFAULT FALSE `critical` field is omitted when false, per DER's rule that defaults
  // are not encoded.
  return critical
    ? sequence(objectIdentifier(oid), boolean(true), octetString(value))
    : sequence(objectIdentifier(oid), octetString(value));
}

function subjectAltName(ipAddresses: readonly string[], hostnames: readonly string[]): Der {
  const names: Der[] = [
    // [2] dNSName
    ...hostnames.map((host) => contextPrimitive(2, Uint8Array.from(host, (c) => c.charCodeAt(0)))),
    // [7] iPAddress, four raw bytes
    ...ipAddresses.map((ip) =>
      contextPrimitive(7, Uint8Array.from(ip.split('.').map((part) => Number(part) & 0xff))),
    ),
  ];
  return sequence(...names);
}

function serialNumber(): Der {
  // 16 random bytes with the high bit cleared, so it is unambiguously positive.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[0] = (bytes[0] ?? 1) & 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

const formatFingerprint = (raw: string): string => raw.replace(/:/g, '').toLowerCase();

export const isIpv4 = (value: string): boolean => {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
};

// ── persistence ─────────────────────────────────────────────────────────────────

export interface CertificateStore {
  /**
   * Returns usable material, generating it when absent, expired, or when the machine's LAN
   * address has changed — a certificate minted for an old DHCP lease is useless.
   */
  ensure(options: GenerateOptions): CertificateMaterial;
  load(): CertificateMaterial | null;
  clear(): void;
}

export interface StorePaths {
  certificatePath: string;
  privateKeyPath: string;
}

export const certificatePaths = (userDataDir: string): StorePaths => ({
  certificatePath: join(userDataDir, 'wireless-camera', 'certificate.pem'),
  privateKeyPath: join(userDataDir, 'wireless-camera', 'private-key.pem'),
});

export function createCertificateStore(paths: StorePaths): CertificateStore {
  const load = (): CertificateMaterial | null => {
    if (!existsSync(paths.certificatePath) || !existsSync(paths.privateKeyPath)) return null;

    try {
      const certificatePem = readFileSync(paths.certificatePath, 'utf8');
      const privateKeyPem = readFileSync(paths.privateKeyPath, 'utf8');
      const parsed = new X509Certificate(certificatePem);

      return {
        certificatePem,
        privateKeyPem,
        fingerprint: formatFingerprint(parsed.fingerprint256),
        validFrom: new Date(parsed.validFrom).toISOString(),
        validTo: new Date(parsed.validTo).toISOString(),
        subjectAltNames: parseSubjectAltNames(parsed.subjectAltName ?? ''),
      };
    } catch {
      // A corrupt or unreadable certificate is not fatal: it is regenerated. Throwing here
      // would block the whole feature over a file that can simply be replaced.
      return null;
    }
  };

  return {
    load,

    ensure(options) {
      const now = options.now ?? new Date();
      const existing = load();

      if (existing && isStillUsable(existing, options, now)) return existing;

      const material = generateSelfSignedCertificate(options);

      mkdirSync(dirname(paths.certificatePath), { recursive: true });
      writeFileSync(paths.certificatePath, material.certificatePem, 'utf8');
      // The private key is written with owner-only permissions. Ignored on Windows, where
      // the app data directory is already per-user.
      writeFileSync(paths.privateKeyPath, material.privateKeyPem, { encoding: 'utf8', mode: 0o600 });

      return material;
    },

    clear() {
      rmSync(paths.certificatePath, { force: true });
      rmSync(paths.privateKeyPath, { force: true });
    },
  };
}

/**
 * A stored certificate is reused only if it is currently valid, not about to expire, and
 * already covers every address the server is about to bind.
 */
function isStillUsable(
  material: CertificateMaterial,
  options: GenerateOptions,
  now: Date,
): boolean {
  const validTo = Date.parse(material.validTo);
  const validFrom = Date.parse(material.validFrom);
  if (Number.isNaN(validTo) || Number.isNaN(validFrom)) return false;

  // Re-mint a week early rather than letting a service fail mid-week on expiry.
  if (now.getTime() > validTo - 7 * 86_400_000) return false;
  if (now.getTime() < validFrom) return false;

  const covered = new Set(material.subjectAltNames);
  const required = [...options.ipAddresses.filter(isIpv4), ...(options.hostnames ?? [])];
  return required.every((address) => covered.has(address));
}

function parseSubjectAltNames(subjectAltName: string): string[] {
  // Node formats this as "DNS:localhost, IP Address:192.168.1.100".
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => entry.replace(/^(DNS|IP Address|URI|email):/i, '').trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Onboarding copy for the pairing screen (Section 3). The warning is expected, so the UI
 * explains it in advance instead of letting the operator think something is broken.
 */
export const CERTIFICATE_TRUST_GUIDANCE = Object.freeze({
  headline: 'Your phone will show a security warning the first time.',
  explanation:
    'Exceptionel Presenter creates its own certificate so your phone can use its camera. ' +
    'The connection stays on your local network and never reaches the internet, but your ' +
    'phone has no way to recognise a certificate that was made on this computer.',
  steps: Object.freeze([
    'On iPhone: tap "Show Details", then "visit this website".',
    'On Android: tap "Advanced", then "Proceed".',
    'This is only needed once per phone, per certificate.',
  ]),
  reassurance:
    'Video travels directly from your phone to this computer over Wi-Fi. It is never uploaded.',
});
