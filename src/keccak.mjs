// Keccak-256 (the original Keccak padding used by Ethereum, not NIST SHA3-256).
// Small, dependency-free and written for clarity: it hashes event signatures
// and short calldata, so speed does not matter here.

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed x + 5 * y.
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

const RATE_BYTES = 136;

function rotl(value, shift) {
  if (shift === 0) return value;
  const s = BigInt(shift);
  return ((value << s) | (value >> (64n - s))) & MASK;
}

function permute(a) {
  const c = new Array(5);
  const b = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROTATION[x + 5 * y]);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      }
    }
    a[0] ^= ROUND_CONSTANTS[round];
  }
}

/** Convert a 0x-prefixed hex string to bytes. Throws on anything that is not whole bytes of hex. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new TypeError('expected a 0x-prefixed hex string of whole bytes');
  }
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Convert bytes to a lower-case 0x-prefixed hex string. */
export function bytesToHex(bytes) {
  let out = '0x';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function sponge(input, domainByte) {
  const message = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (!(message instanceof Uint8Array)) throw new TypeError('expected a string or a Uint8Array');

  const paddedLength = Math.ceil((message.length + 1) / RATE_BYTES) * RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] ^= domainByte;
  padded[paddedLength - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let i = 7; i >= 0; i--) word = (word << 8n) | BigInt(padded[offset + lane * 8 + i]);
      state[lane] ^= word;
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane];
    for (let i = 0; i < 8; i++) {
      out[lane * 8 + i] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return bytesToHex(out);
}

/**
 * Keccak-256 of a Uint8Array or of a string (strings are hashed as UTF-8).
 * Returns a lower-case 0x-prefixed hex string of 32 bytes.
 */
export function keccak256(input) {
  return sponge(input, 0x01);
}

/**
 * NIST SHA3-256: the same sponge with a different padding byte. Exported so the
 * tests can check the permutation against the platform's own SHA3-256.
 */
export function sha3_256(input) {
  return sponge(input, 0x06);
}
