// Parser for .slog binary shot files
// Mirrors shot_log_format.h

const HEADER_SIZE_V4 = 128;
const HEADER_SIZE_V5 = 512;
const MAGIC = 0x544f4853; // 'SHOT'

const TEMP_SCALE = 10;
const PRESSURE_SCALE = 10;
const FLOW_SCALE = 100;
const WEIGHT_SCALE = 10;
const RESISTANCE_SCALE = 100;

// Field bit positions (must match shot_log_format.h)
const FIELD_BITS = {
  T: 0,    // tick
  TT: 1,   // target temp
  CT: 2,   // current temp
  TP: 3,   // target pressure
  CP: 4,   // current pressure
  FL: 5,   // pump flow
  TF: 6,   // target flow
  PF: 7,   // puck flow
  VF: 8,   // volumetric flow
  V: 9,    // volumetric weight
  EV: 10,  // estimated weight
  PR: 11,  // puck resistance
  SI: 12,  // system info (v2+)
};

interface FieldDef {
  name: string;
  type: 'uint8' | 'uint16' | 'int16';
  scale: number | null;
  transform?: (val: number, sampleInterval?: number) => any;
}

// Field definitions with parsing info
const FIELD_DEFS: { [key: number]: FieldDef } = {
  [FIELD_BITS.T]: {
    name: 't',
    type: 'uint16',
    scale: null,
    transform: (val, sampleInterval) => val * (sampleInterval || 100),
  },
  [FIELD_BITS.TT]: { name: 'tt', type: 'uint16', scale: TEMP_SCALE },
  [FIELD_BITS.CT]: { name: 'ct', type: 'uint16', scale: TEMP_SCALE },
  [FIELD_BITS.TP]: { name: 'tp', type: 'uint16', scale: PRESSURE_SCALE },
  [FIELD_BITS.CP]: { name: 'cp', type: 'uint16', scale: PRESSURE_SCALE },
  [FIELD_BITS.FL]: { name: 'fl', type: 'int16', scale: FLOW_SCALE },
  [FIELD_BITS.TF]: { name: 'tf', type: 'int16', scale: FLOW_SCALE },
  [FIELD_BITS.PF]: { name: 'pf', type: 'int16', scale: FLOW_SCALE },
  [FIELD_BITS.VF]: { name: 'vf', type: 'int16', scale: FLOW_SCALE },
  [FIELD_BITS.V]: { name: 'v', type: 'uint16', scale: WEIGHT_SCALE },
  [FIELD_BITS.EV]: { name: 'ev', type: 'uint16', scale: WEIGHT_SCALE },
  [FIELD_BITS.PR]: { name: 'pr', type: 'uint16', scale: RESISTANCE_SCALE },
  [FIELD_BITS.SI]: {
    name: 'systemInfo',
    type: 'uint16',
    scale: null,
    transform: val => ({
      raw: val,
      shotStartedVolumetric: !!(val & 0x0001),
      currentlyVolumetric: !!(val & 0x0002),
      bluetoothScaleConnected: !!(val & 0x0004),
      volumetricAvailable: !!(val & 0x0008),
      extendedRecording: !!(val & 0x0010),
    }),
  },
};

function decodeCString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function countSetBits(n: number): number {
  let count = 0;
  while (n) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

export interface PhaseTransition {
  sampleIndex: number;
  phaseNumber: number;
  phaseName: string;
}

export interface ShotSample {
  [key: string]: any;
  t?: number;
  tt?: number;
  ct?: number;
  tp?: number;
  cp?: number;
  fl?: number;
  tf?: number;
  pf?: number;
  vf?: number;
  v?: number;
  ev?: number;
  pr?: number;
  systemInfo?: any;
  phase?: number;
}

export interface ShotData {
  id: string;
  version: number;
  fieldsMask: number;
  sampleCount: number;
  sampleInterval: number;
  profileId: string;
  profileName: string;
  timestamp: number;
  rating: number;
  duration: number;
  weight: number | null;
  samples: ShotSample[];
  phases: PhaseTransition[];
  incomplete: boolean;
}

/**
 * Parse binary shot file (.slog format)
 */
export function parseBinaryShot(buffer: Buffer, id: string): ShotData {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (view.byteLength < HEADER_SIZE_V4) {
    throw new Error('Shot file too small');
  }

  // Parse header
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`Invalid shot magic: 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`);
  }

  const version = view.getUint8(4);
  const reserved0 = view.getUint8(5);
  const headerSize = view.getUint16(6, true);
  const actualHeaderSize = version >= 5 ? HEADER_SIZE_V5 : HEADER_SIZE_V4;

  if (view.byteLength < actualHeaderSize) {
    throw new Error(`Shot file too small for version ${version}`);
  }

  const sampleInterval = view.getUint16(8, true);
  const reserved1 = view.getUint16(10, true);
  const fieldsMask = view.getUint32(12, true);
  const sampleCount = view.getUint32(16, true);
  const duration = view.getUint32(20, true);
  const timestamp = view.getUint32(24, true);
  const profileIdBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + 28, 32);
  const profileNameBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + 60, 48);
  const weight = view.getUint16(108, true);
  
  // Phase transitions start at offset 110 for v5+
  const transitionCount = version >= 5 ? view.getUint8(458) : 0;
  
  // Rating is not in the header - set to 0
  const rating = 0;

  const profileId = decodeCString(profileIdBytes);
  const profileName = decodeCString(profileNameBytes);
  
  // Convert weight from scaled integer
  const weightFloat = weight > 0 ? weight / WEIGHT_SCALE : null;

  // Parse phase transitions (v5+)
  const phases: PhaseTransition[] = [];
  if (version >= 5 && transitionCount > 0) {
    const baseOffset = 110;  // Phase transitions start after finalWeight
    for (let i = 0; i < transitionCount && i < 12; i++) {
      const offset = baseOffset + i * 29;
      const sampleIndex = view.getUint16(offset, true);
      const phaseNumber = view.getUint8(offset + 2);
      const phaseNameBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset + 4, 25);
      const phaseName = decodeCString(phaseNameBytes);
      phases.push({ sampleIndex, phaseNumber, phaseName });
    }
  }

  // Calculate sample data size
  const fieldsPerSample = countSetBits(fieldsMask);
  const sampleDataSize = fieldsPerSample * 2; // Each field is 2 bytes
  const totalSampleSize = sampleCount * sampleDataSize;
  const expectedSize = actualHeaderSize + totalSampleSize;

  if (view.byteLength < expectedSize) {
    console.warn(
      `Shot file truncated: ${view.byteLength} bytes (expected ${expectedSize}). ` +
      `Samples may be incomplete.`
    );
  }

  // Build field order based on mask
  const fieldOrder: number[] = [];
  for (let bit = 0; bit <= 12; bit++) {
    if (fieldsMask & (1 << bit)) {
      fieldOrder.push(bit);
    }
  }

  // Parse samples
  const samples: ShotSample[] = [];
  const actualSamples = Math.min(sampleCount, Math.floor((view.byteLength - actualHeaderSize) / sampleDataSize));

  for (let i = 0; i < actualSamples; i++) {
    const sample: ShotSample = {};
    const sampleOffset = actualHeaderSize + i * sampleDataSize;

    // Add phase number based on transitions
    for (let j = phases.length - 1; j >= 0; j--) {
      if (i >= phases[j].sampleIndex) {
        sample.phase = phases[j].phaseNumber;
        break;
      }
    }

    // Parse each field in this sample
    fieldOrder.forEach((fieldBit, fieldIndex) => {
      const fieldDef = FIELD_DEFS[fieldBit];
      if (!fieldDef) return;

      const fieldOffset = sampleOffset + fieldIndex * 2;
      let value: number;

      if (fieldDef.type === 'int16') {
        value = view.getInt16(fieldOffset, true);
      } else {
        value = view.getUint16(fieldOffset, true);
      }

      if (fieldDef.transform) {
        sample[fieldDef.name] = fieldDef.transform(value, sampleInterval);
      } else if (fieldDef.scale) {
        sample[fieldDef.name] = value / fieldDef.scale;
      } else {
        sample[fieldDef.name] = value;
      }
    });

    samples.push(sample);
  }

  const incomplete = actualSamples < sampleCount;
  if (incomplete) {
    console.warn(`Shot ${id} is incomplete: ${actualSamples}/${sampleCount} samples`);
  }

  return {
    id,
    version,
    fieldsMask,
    sampleCount: actualSamples,
    sampleInterval,
    profileId,
    profileName,
    timestamp,
    rating,
    duration,
    weight: weightFloat,
    samples,
    phases,
    incomplete,
  };
}