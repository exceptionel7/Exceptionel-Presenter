/**
 * EXCEPTIONEL PRESENTER — minimal DER (ASN.1) writer.
 *
 * Exists so the Wireless Camera service can mint its own self-signed certificate with NO
 * third-party dependency. Node has key generation and signing but no certificate builder,
 * and the usual answer is an npm package. A church machine generating a cert on first run
 * should not depend on one, and — more practically — a hand-rolled encoder can be verified
 * here by round-tripping through Node's own `X509Certificate` parser, whereas a package
 * could not be tested in this environment at all.
 *
 * Only the subset X.509 needs is implemented. This is not a general ASN.1 library.
 */

export type Der = Uint8Array;

/**
 * DER length: short form below 128, otherwise long form with a leading count byte.
 * Getting this wrong produces a certificate that parses on some stacks and not others, so
 * it is the one piece worth reading closely.
 */
function encodeLength(length: number): Der {
  if (length < 0x80) return Uint8Array.of(length);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, content: Der): Der {
  const length = encodeLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

export const concat = (...parts: Der[]): Der => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const sequence = (...items: Der[]): Der => tlv(0x30, concat(...items));
export const set = (...items: Der[]): Der => tlv(0x31, concat(...items));
export const octetString = (content: Der): Der => tlv(0x04, content);
export const boolean = (value: boolean): Der => tlv(0x01, Uint8Array.of(value ? 0xff : 0x00));
export const nullValue = (): Der => tlv(0x05, new Uint8Array(0));

/** Raw DER that has already been produced elsewhere, e.g. an SPKI export from node:crypto. */
export const raw = (bytes: Der): Der => bytes;

/**
 * INTEGER, always positive.
 *
 * A leading 0x00 is prepended when the high bit is set, because DER integers are signed and
 * a serial number that happens to start with a high byte would otherwise be read as
 * negative — which some validators reject outright.
 */
export function integer(value: Der | number): Der {
  if (typeof value === 'number') {
    if (value === 0) return tlv(0x02, Uint8Array.of(0));
    const bytes: number[] = [];
    let remaining = value;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
    return tlv(0x02, Uint8Array.from(bytes));
  }

  let start = 0;
  while (start < value.length - 1 && value[start] === 0 && !((value[start + 1] ?? 0) & 0x80)) start++;
  const trimmed = value.subarray(start);
  return (trimmed[0] ?? 0) & 0x80
    ? tlv(0x02, concat(Uint8Array.of(0), trimmed))
    : tlv(0x02, trimmed);
}

/** BIT STRING with no unused trailing bits unless stated. */
export const bitString = (content: Der, unusedBits = 0): Der =>
  tlv(0x03, concat(Uint8Array.of(unusedBits), content));

/** OBJECT IDENTIFIER from dotted notation, e.g. "1.2.840.10045.4.3.2". */
export function objectIdentifier(dotted: string): Der {
  const parts = dotted.split('.').map(Number);
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`invalid OID: ${dotted}`);
  }

  // The first two arcs are packed into a single byte as 40*first + second.
  const bytes: number[] = [40 * parts[0]! + parts[1]!];

  for (const part of parts.slice(2)) {
    // Base-128, most significant group first, continuation bit set on all but the last.
    const group: number[] = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      group.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    bytes.push(...group);
  }

  return tlv(0x06, Uint8Array.from(bytes));
}

const ascii = (text: string): Der => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

export const printableString = (text: string): Der => tlv(0x13, ascii(text));
export const ia5String = (text: string): Der => tlv(0x16, ascii(text));
export const utf8String = (text: string): Der => tlv(0x0c, new TextEncoder().encode(text));

/**
 * UTCTime, as YYMMDDHHMMSSZ.
 *
 * X.509 mandates UTCTime for dates before 2050 and GeneralizedTime after, so this throws
 * rather than silently emitting a certificate that validators will reject.
 */
export function utcTime(date: Date): Der {
  const year = date.getUTCFullYear();
  if (year < 1950 || year >= 2050) {
    throw new Error(`UTCTime cannot represent ${year}; GeneralizedTime is required`);
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  const text =
    `${pad(year % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, ascii(text));
}

/** Context-specific constructed tag, e.g. [0] EXPLICIT. */
export const contextConstructed = (tagNumber: number, ...items: Der[]): Der =>
  tlv(0xa0 | tagNumber, concat(...items));

/** Context-specific primitive tag, e.g. GeneralName's [2] dNSName. */
export const contextPrimitive = (tagNumber: number, content: Der): Der =>
  tlv(0x80 | tagNumber, content);

/** Wraps DER bytes as a PEM block. */
export function toPem(der: Der, label: string): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
