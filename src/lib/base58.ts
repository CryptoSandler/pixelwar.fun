/**
 * Base58 encode/decode. Lives here, outside `lib/tokens/`, because it is not
 * a token concern: it backs `lib/tokens/addresses.ts`'s address checks (and,
 * via `validateAddress`, `paymentWallet` in `lib/payments/config.ts`), and it
 * separately backs `lib/payments/solana.ts`'s signature-shape check, which
 * has nothing to do with what a token is called.
 *
 * This is the one copy. Before this module existed, `config.ts` carried a
 * private decoder that had already drifted from `solana.ts`'s own private
 * copy inside a single batch — one rejected empty input, the other did not.
 * Duplicated logic like that does not stay identical; it stays until someone
 * hits the difference.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i]] = i;

/** Decodes a base58 string to bytes. Returns null when any character is outside the alphabet. */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;

  const bytes: number[] = [0];
  for (const char of input) {
    const value = INDEX[char];
    if (value === undefined) return null;

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' is a leading zero byte.
  for (const char of input) {
    if (char !== ALPHABET[0]) break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let leadingZeros = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros += ALPHABET[0];
  }

  return leadingZeros + digits.reverse().map((d) => ALPHABET[d]).join("");
}
