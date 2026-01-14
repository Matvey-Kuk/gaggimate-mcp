import { ShotData, ShotSample, PhaseTransition } from '../parsers/binaryShot.js';

interface TransformedSample {
  time_seconds: number;
  temperature_c: number;
  pressure_bar: number;
  flow_ml_s: number;
  weight_g: number;
}

interface PhaseData {
  name: string;
  phase_number: number;
  start_time_seconds: number;
  duration_seconds: number;
  sample_count: number;
  avg_temperature_c: number;
  avg_pressure_bar: number;
  total_flow_ml: number;
  samples: TransformedSample[];
}

interface ShotSummary {
  temperature: {
    min_celsius: number;
    max_celsius: number;
    average_celsius: number;
    target_average: number;
  };
  pressure: {
    min_bar: number;
    max_bar: number;
    average_bar: number;
    peak_time_seconds: number;
  };
  flow: {
    total_volume_ml: number;
    average_flow_rate_ml_s: number;
    peak_flow_ml_s: number;
    time_to_first_drip_seconds: number | null;
  };
  extraction: {
    extraction_time_seconds: number;
    preinfusion_time_seconds: number;
    main_extraction_seconds: number;
  };
}

interface TransformedShot {
  metadata: {
    shot_id: string;
    profile_name: string;
    profile_id: string;
    timestamp: string;
    duration_seconds: number;
    final_weight_grams: number | null;
    sample_count: number;
    sample_interval_ms: number;
    bluetooth_scale_connected: boolean;
    volumetric_mode: boolean;
  };
  summary: ShotSummary;
  phases: PhaseData[];
  full_curve?: TransformedSample[];
}

export function transformShotForAI(shot: ShotData, includeFullCurve: boolean = false): TransformedShot {
  // Extract bluetooth scale and volumetric info from first sample
  const firstSample = shot.samples[0];
  const bluetoothConnected = firstSample?.systemInfo?.bluetoothScaleConnected || false;
  const volumetricMode = firstSample?.systemInfo?.shotStartedVolumetric || false;

  // Calculate summaries
  const summary = calculateSummary(shot);

  // Process phases
  const phases = processPhases(shot);

  // Build result
  const result: TransformedShot = {
    metadata: {
      shot_id: shot.id,
      profile_name: shot.profileName,
      profile_id: shot.profileId,
      timestamp: new Date(shot.timestamp * 1000).toISOString(),
      duration_seconds: shot.duration / 1000,
      final_weight_grams: shot.weight,
      sample_count: shot.sampleCount,
      sample_interval_ms: shot.sampleInterval,
      bluetooth_scale_connected: bluetoothConnected,
      volumetric_mode: volumetricMode,
    },
    summary,
    phases,
  };

  // Include full curve data if requested
  if (includeFullCurve) {
    result.full_curve = shot.samples.map(sample => ({
      time_seconds: (sample.t || 0) / 1000,
      temperature_c: sample.ct || 0,
      pressure_bar: sample.cp || 0,
      flow_ml_s: sample.pf || 0,
      weight_g: sample.v || 0,
    }));
  }

  return result;
}

function calculateSummary(shot: ShotData): ShotSummary {
  const samples = shot.samples;
  
  // Temperature statistics
  const temperatures = samples.map(s => s.ct || 0).filter(t => t > 0);
  const targetTemps = samples.map(s => s.tt || 0).filter(t => t > 0);
  
  // Pressure statistics
  const pressures = samples.map(s => s.cp || 0);
  const maxPressure = Math.max(...pressures);
  const peakPressureIndex = pressures.indexOf(maxPressure);
  const peakPressureTime = (samples[peakPressureIndex]?.t || 0) / 1000;
  
  // Flow statistics
  const flows = samples.map(s => s.pf || 0); // Use puck flow as it's the actual flow through coffee
  const totalVolume = calculateTotalVolume(samples, shot.sampleInterval);
  const nonZeroFlows = flows.filter(f => f > 0);
  const avgFlow = nonZeroFlows.length > 0 
    ? nonZeroFlows.reduce((a, b) => a + b, 0) / nonZeroFlows.length 
    : 0;
  
  // Find time to first drip (first positive weight or flow)
  let timeToFirstDrip: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    if ((samples[i].v && samples[i].v! > 0.5) || (samples[i].pf && samples[i].pf! > 0.1)) {
      timeToFirstDrip = (samples[i].t || 0) / 1000;
      break;
    }
  }
  
  // Calculate preinfusion time (based on phases if available)
  let preinfusionTime = 0;
  if (shot.phases.length > 0) {
    // Find the end of preinfusion phases (usually phase 0, 1, and sometimes 2 for soak)
    for (const phase of shot.phases) {
      if (phase.phaseName.toLowerCase().includes('preinfusion') || 
          phase.phaseName.toLowerCase().includes('soak')) {
        const phaseEndIndex = shot.phases.indexOf(phase) < shot.phases.length - 1 
          ? shot.phases[shot.phases.indexOf(phase) + 1].sampleIndex 
          : shot.samples.length;
        const phaseEndTime = (shot.samples[phaseEndIndex - 1]?.t || 0) / 1000;
        preinfusionTime = Math.max(preinfusionTime, phaseEndTime);
      }
    }
  }
  
  return {
    temperature: {
      min_celsius: Math.min(...temperatures),
      max_celsius: Math.max(...temperatures),
      average_celsius: temperatures.reduce((a, b) => a + b, 0) / temperatures.length,
      target_average: targetTemps.reduce((a, b) => a + b, 0) / targetTemps.length,
    },
    pressure: {
      min_bar: Math.min(...pressures),
      max_bar: maxPressure,
      average_bar: pressures.reduce((a, b) => a + b, 0) / pressures.length,
      peak_time_seconds: peakPressureTime,
    },
    flow: {
      total_volume_ml: totalVolume,
      average_flow_rate_ml_s: avgFlow,
      peak_flow_ml_s: Math.max(...flows),
      time_to_first_drip_seconds: timeToFirstDrip,
    },
    extraction: {
      extraction_time_seconds: shot.duration / 1000,
      preinfusion_time_seconds: preinfusionTime,
      main_extraction_seconds: (shot.duration / 1000) - preinfusionTime,
    },
  };
}

function calculateTotalVolume(samples: ShotSample[], intervalMs: number): number {
  // Integrate flow over time to get volume
  let totalVolume = 0;
  const intervalSeconds = intervalMs / 1000;
  
  for (const sample of samples) {
    const flow = sample.pf || 0; // ml/s
    totalVolume += flow * intervalSeconds; // ml
  }
  
  return Math.round(totalVolume * 10) / 10; // Round to 0.1 ml
}

function processPhases(shot: ShotData): PhaseData[] {
  const phases: PhaseData[] = [];
  const samples = shot.samples;
  
  for (let i = 0; i < shot.phases.length; i++) {
    const phase = shot.phases[i];
    const nextPhase = shot.phases[i + 1];
    
    const startIndex = phase.sampleIndex;
    const endIndex = nextPhase ? nextPhase.sampleIndex : samples.length;
    const phaseSamples = samples.slice(startIndex, endIndex);
    
    if (phaseSamples.length === 0) continue;
    
    // Calculate phase statistics
    const temperatures = phaseSamples.map(s => s.ct || 0).filter(t => t > 0);
    const pressures = phaseSamples.map(s => s.cp || 0);
    const totalFlow = calculateTotalVolume(phaseSamples, shot.sampleInterval);
    
    // Select representative samples (beginning, middle, end)
    const representativeSamples: TransformedSample[] = [];
    const indices = [
      0, // First
      Math.floor(phaseSamples.length / 2), // Middle
      phaseSamples.length - 1, // Last
    ];
    
    // Remove duplicates if phase is very short
    const uniqueIndices = [...new Set(indices)];
    
    for (const idx of uniqueIndices) {
      const sample = phaseSamples[idx];
      if (sample) {
        representativeSamples.push({
          time_seconds: (sample.t || 0) / 1000,
          temperature_c: sample.ct || 0,
          pressure_bar: sample.cp || 0,
          flow_ml_s: sample.pf || 0,
          weight_g: sample.v || 0,
        });
      }
    }
    
    const startTime = (phaseSamples[0].t || 0) / 1000;
    const endTime = (phaseSamples[phaseSamples.length - 1].t || 0) / 1000;
    
    phases.push({
      name: phase.phaseName,
      phase_number: phase.phaseNumber,
      start_time_seconds: startTime,
      duration_seconds: endTime - startTime,
      sample_count: phaseSamples.length,
      avg_temperature_c: temperatures.length > 0 
        ? Math.round(temperatures.reduce((a, b) => a + b, 0) / temperatures.length * 10) / 10
        : 0,
      avg_pressure_bar: pressures.length > 0
        ? Math.round(pressures.reduce((a, b) => a + b, 0) / pressures.length * 10) / 10
        : 0,
      total_flow_ml: totalFlow,
      samples: representativeSamples,
    });
  }
  
  // Handle case where there are no phases defined
  if (phases.length === 0 && samples.length > 0) {
    // Create a single phase for the entire shot
    const temperatures = samples.map(s => s.ct || 0).filter(t => t > 0);
    const pressures = samples.map(s => s.cp || 0);
    const totalFlow = calculateTotalVolume(samples, shot.sampleInterval);
    
    const representativeSamples: TransformedSample[] = [];
    const indices = [0, Math.floor(samples.length / 2), samples.length - 1];
    const uniqueIndices = [...new Set(indices)];
    
    for (const idx of uniqueIndices) {
      const sample = samples[idx];
      if (sample) {
        representativeSamples.push({
          time_seconds: (sample.t || 0) / 1000,
          temperature_c: sample.ct || 0,
          pressure_bar: sample.cp || 0,
          flow_ml_s: sample.pf || 0,
          weight_g: sample.v || 0,
        });
      }
    }
    
    phases.push({
      name: 'extraction',
      phase_number: 0,
      start_time_seconds: 0,
      duration_seconds: shot.duration / 1000,
      sample_count: samples.length,
      avg_temperature_c: temperatures.length > 0
        ? Math.round(temperatures.reduce((a, b) => a + b, 0) / temperatures.length * 10) / 10
        : 0,
      avg_pressure_bar: pressures.length > 0
        ? Math.round(pressures.reduce((a, b) => a + b, 0) / pressures.length * 10) / 10
        : 0,
      total_flow_ml: totalFlow,
      samples: representativeSamples,
    });
  }
  
  return phases;
}