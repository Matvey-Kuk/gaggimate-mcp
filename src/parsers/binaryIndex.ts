// Parser for index.bin binary shot index files
// Mirrors shot_log_format.h ShotIndexHeader and ShotIndexEntry

const INDEX_HEADER_SIZE = 32;
const INDEX_ENTRY_SIZE = 128;
const INDEX_MAGIC = 0x58444953; // 'SIDX'

// Index entry flags
const SHOT_FLAG_COMPLETED = 0x01;
const SHOT_FLAG_DELETED = 0x02;
const SHOT_FLAG_HAS_NOTES = 0x04;

const WEIGHT_SCALE = 10;

function decodeCString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export interface IndexEntry {
  id: number;
  timestamp: number;
  duration: number;
  volume: number | null;
  rating: number;
  flags: number;
  profileId: string;
  profileName: string;
  completed: boolean;
  deleted: boolean;
  hasNotes: boolean;
  incomplete: boolean;
}

export interface IndexData {
  header: {
    magic: number;
    version: number;
    entrySize: number;
    entryCount: number;
    nextId: number;
  };
  entries: IndexEntry[];
}

export interface ShotListItem {
  id: string;
  profile: string;
  profileId: string;
  timestamp: number;
  duration: number;
  samples: number;
  volume: number | null;
  rating: number | null;
  incomplete: boolean;
  notes: null;
  loaded: boolean;
  data: null;
}

/**
 * Parse binary shot index file
 */
export function parseBinaryIndex(buffer: Buffer): IndexData {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (view.byteLength < INDEX_HEADER_SIZE) {
    throw new Error('Index file too small');
  }

  // Parse header
  const magic = view.getUint32(0, true);
  if (magic !== INDEX_MAGIC) {
    throw new Error(
      `Invalid index magic: 0x${magic.toString(16)} (expected 0x${INDEX_MAGIC.toString(16)})`,
    );
  }

  const version = view.getUint16(4, true);
  const entrySize = view.getUint16(6, true);
  const entryCount = view.getUint32(8, true);
  const nextId = view.getUint32(12, true);

  if (entrySize !== INDEX_ENTRY_SIZE) {
    throw new Error(`Unsupported entry size ${entrySize} (expected ${INDEX_ENTRY_SIZE})`);
  }

  const expectedSize = INDEX_HEADER_SIZE + entryCount * INDEX_ENTRY_SIZE;
  if (view.byteLength < expectedSize) {
    throw new Error(`Index file truncated: ${view.byteLength} bytes (expected ${expectedSize})`);
  }

  // Parse entries
  const entries: IndexEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const base = INDEX_HEADER_SIZE + i * INDEX_ENTRY_SIZE;

    const id = view.getUint32(base + 0, true);
    const timestamp = view.getUint32(base + 4, true);
    const duration = view.getUint32(base + 8, true);
    const volume = view.getUint16(base + 12, true);
    const rating = view.getUint8(base + 14);
    const flags = view.getUint8(base + 15);

    const profileIdBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + base + 16, 32);
    const profileNameBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + base + 48, 48);

    const profileId = decodeCString(profileIdBytes);
    const profileName = decodeCString(profileNameBytes);

    // Convert volume from scaled integer to float
    const volumeFloat = volume > 0 ? volume / WEIGHT_SCALE : null;

    entries.push({
      id,
      timestamp,
      duration,
      volume: volumeFloat,
      rating,
      flags,
      profileId,
      profileName,
      // Computed flags
      completed: !!(flags & SHOT_FLAG_COMPLETED),
      deleted: !!(flags & SHOT_FLAG_DELETED),
      hasNotes: !!(flags & SHOT_FLAG_HAS_NOTES),
      incomplete: !(flags & SHOT_FLAG_COMPLETED),
    });
  }

  return {
    header: {
      magic,
      version,
      entrySize,
      entryCount,
      nextId,
    },
    entries,
  };
}

/**
 * Filter out deleted entries and convert to frontend format
 */
export function indexToShotList(indexData: IndexData): ShotListItem[] {
  return indexData.entries
    .filter(entry => !entry.deleted)
    .map(entry => ({
      id: entry.id.toString(),
      profile: entry.profileName,
      profileId: entry.profileId,
      timestamp: entry.timestamp,
      duration: entry.duration,
      samples: 0, // Not available in index, filled when loading full shot
      volume: entry.volume,
      rating: entry.rating > 0 ? entry.rating : null,
      incomplete: entry.incomplete,
      notes: null,
      loaded: false,
      data: null,
    }))
    .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
}