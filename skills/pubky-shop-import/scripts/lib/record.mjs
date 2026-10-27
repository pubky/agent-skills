// Turns a plan entry into the signed-by-path listing record the Shop expects.
import { CONTRACT_VERSION } from "./listing-schema.mjs";
import { MEDIA_PREFIX } from "./common.mjs";

export function materialize(entry, owner, extra = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CONTRACT_VERSION,
    recordType: "listing",
    ownerPubky: owner,
    revision: extra.revision ?? 1,
    createdAt: extra.createdAt ?? now,
    updatedAt: extra.updatedAt ?? now,
    listingId: entry.listingId,
    state: extra.state ?? "active",
    ...entry.draft,
    media: entry.media.map(({ id, type, mimeType, byteSize, width, height, contentHash, altText }) => ({
      id,
      type,
      url: `pubky://${owner}${MEDIA_PREFIX}${id}`,
      contentHash,
      mimeType,
      byteSize,
      width,
      height,
      altText,
    })),
    variants: entry.draft.variants.map((variant) => ({ ...variant, mediaIds: entry.media.map((m) => m.id) })),
  };
}

/** Record content without the bookkeeping fields, for "did anything change?" checks. */
export function contentKey(record) {
  const { revision, createdAt, updatedAt, ...rest } = record;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
