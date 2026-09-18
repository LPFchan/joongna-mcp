/**
 * Reading the caller's identity out of the headers the gateway attached.
 *
 * This Worker declares no route. It is reachable only through the service
 * binding the gateway Worker declares, and by the time a request arrives the
 * gateway has already asked auth.lost.plus who the caller is and been told.
 * The credential itself never gets here: the gateway drops `Authorization` and
 * `x-api-key` before forwarding, so there is nothing to validate and nothing
 * to replay.
 *
 * Five headers arrive:
 *
 *   x-lost-plus-sub        the account id
 *   x-lost-plus-email
 *   x-lost-plus-name       display name, often non-ASCII
 *   x-lost-plus-role       `administrator` or `user`
 *   x-lost-plus-encoding   always `percent-utf8`
 *
 * The first four are percent-encoded. That is not only about carrying
 * non-ASCII -- encoding everything outside `A-Z a-z 0-9 * - . _` is what stops
 * a display name from containing CR or LF and injecting a header of its own.
 * So the values have to be decoded here, and a value that will not decode is
 * not an identity.
 *
 * A space arrives as `%20`, never as `+`: the gateway rewrites the one `+` its
 * encoder would produce. So `decodeURIComponent` is the right decoder and a
 * literal `+` in a decoded value is a literal `+`.
 *
 * `role` is carried through without being checked against a list. The gateway
 * already refuses anything other than `administrator` or `user`, and nothing
 * here reads the value -- every tool is available to any admitted caller.
 * Re-checking it would mean this file has to be edited the day a third role
 * exists, for no benefit today.
 */

export interface Identity {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
}

/** The only encoding the gateway emits, and the only one understood here. */
const ENCODING = "percent-utf8";

function decoded(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A truncated or non-hex escape. `decodeURIComponent` throws URIError, and
    // an unhandled throw here would be a 500 with no explanation rather than a
    // refusal, so it is caught and read as "no identity".
    return null;
  }
}

/**
 * The identity the gateway vouched for, or null.
 *
 * Null means refuse. It does not mean "anonymous" and there is no caller that
 * should read it that way -- see the comment on `refused` in index.ts.
 *
 * The encoding header is required rather than assumed. If some future gateway
 * sends these values raw, every one of them would still be read here as though
 * it were percent-encoded, and `%` in a display name would start silently
 * corrupting identities. Requiring the declaration turns that into a refusal.
 */
export function identityFrom(headers: Headers): Identity | null {
  if (headers.get("x-lost-plus-encoding") !== ENCODING) return null;

  const sub = decoded(headers.get("x-lost-plus-sub"));
  const email = decoded(headers.get("x-lost-plus-email"));
  const name = decoded(headers.get("x-lost-plus-name"));
  const role = decoded(headers.get("x-lost-plus-role"));

  // Every field is required and none may be empty. A half-filled identity is a
  // gateway fault, and guessing at the missing half is how a service ends up
  // serving someone it cannot name.
  if (sub === null || sub === "") return null;
  if (email === null || email === "") return null;
  if (name === null || name === "") return null;
  if (role === null || role === "") return null;

  return { sub, email, name, role };
}
