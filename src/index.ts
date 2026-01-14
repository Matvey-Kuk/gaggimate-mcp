#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { parseBinaryIndex, indexToShotList } from "./parsers/binaryIndex.js";
import { parseBinaryShot } from "./parsers/binaryShot.js";
import { transformShotForAI } from "./transformers/shotTransformer.js";

// Configuration from environment
const GAGGIMATE_HOST = process.env.GAGGIMATE_HOST || "localhost";
const GAGGIMATE_PROTOCOL = process.env.GAGGIMATE_PROTOCOL || "ws";
const HTTP_PROTOCOL = GAGGIMATE_PROTOCOL === 'wss' ? 'https' : 'http';
const REQUEST_TIMEOUT = 5000; // 5 seconds timeout

// Generate unique request ID
function generateRequestId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Fetch profiles from Gaggimate WebSocket API
async function fetchProfilesFromGaggimate(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const WEBSOCKET_URL = `${GAGGIMATE_PROTOCOL}://${GAGGIMATE_HOST}/ws`;
    const ws = new WebSocket(WEBSOCKET_URL);
    const requestId = generateRequestId();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    // Cleanup function to ensure proper closure
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    // Set timeout
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Request timeout: No response from Gaggimate at ${WEBSOCKET_URL}`));
      }
    }, REQUEST_TIMEOUT);

    ws.on("open", () => {
      // Send profiles list request
      const request = {
        tp: "req:profiles:list",
        rid: requestId,
      };
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // Check if this is our response
        if (response.tp === "res:profiles:list" && response.rid === requestId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            
            if (response.error) {
              reject(new Error(`Gaggimate API error: ${response.error}`));
            } else {
              resolve(response.profiles || []);
            }
          }
        }
        // Ignore other message types (like evt:status)
      } catch (error) {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Failed to parse response: ${error}`));
        }
      }
    });

    ws.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`WebSocket error: ${error.message}`));
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        reject(new Error(`WebSocket closed unexpectedly`));
      }
    });
  });
}

// Fetch a specific profile by ID from Gaggimate WebSocket API
async function fetchProfileFromGaggimate(profileId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const WEBSOCKET_URL = `${GAGGIMATE_PROTOCOL}://${GAGGIMATE_HOST}/ws`;
    const ws = new WebSocket(WEBSOCKET_URL);
    const requestId = generateRequestId();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    // Cleanup function to ensure proper closure
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    // Set timeout
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Request timeout: No response from Gaggimate at ${WEBSOCKET_URL}`));
      }
    }, REQUEST_TIMEOUT);

    ws.on("open", () => {
      // Send profile load request
      const request = {
        tp: "req:profiles:load",
        rid: requestId,
        id: profileId,
      };
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // Check if this is our response
        if (response.tp === "res:profiles:load" && response.rid === requestId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            
            if (response.error) {
              reject(new Error(`Gaggimate API error: ${response.error}`));
            } else {
              resolve(response.profile || null);
            }
          }
        }
        // Ignore other message types (like evt:status)
      } catch (error) {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Failed to parse response: ${error}`));
        }
      }
    });

    ws.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`WebSocket error: ${error.message}`));
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        reject(new Error(`WebSocket closed unexpectedly`));
      }
    });
  });
}

// Update or create the AI Profile via WebSocket API
async function updateOrCreateAIProfile(profileData: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const WEBSOCKET_URL = `${GAGGIMATE_PROTOCOL}://${GAGGIMATE_HOST}/ws`;
    const ws = new WebSocket(WEBSOCKET_URL);
    const listRequestId = generateRequestId();
    const saveRequestId = generateRequestId();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;
    let aiProfileId: string | undefined;

    // Cleanup function
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    // Set timeout
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Request timeout: No response from Gaggimate at ${WEBSOCKET_URL}`));
      }
    }, REQUEST_TIMEOUT);

    ws.on("open", () => {
      // First, list profiles to find existing AI Profile
      const listRequest = {
        tp: "req:profiles:list",
        rid: listRequestId,
      };
      ws.send(JSON.stringify(listRequest));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const response = JSON.parse(data.toString());
        
        // Handle profile list response
        if (response.tp === "res:profiles:list" && response.rid === listRequestId) {
          // Find existing AI Profile
          const profiles = response.profiles || [];
          const existingAIProfile = profiles.find((p: any) => p.label === "AI Profile");
          
          if (existingAIProfile) {
            aiProfileId = existingAIProfile.id;
          }
          
          // Build complete profile object
          const profileToSave = {
            ...(aiProfileId ? { id: aiProfileId } : {}),
            label: "AI Profile",
            type: "pro",
            description: "AI-generated espresso profile",
            temperature: profileData.temperature,
            favorite: false,
            selected: false,
            utility: false,
            phases: profileData.phases.map((phase: any) => ({
              name: phase.name,
              phase: phase.phase || "brew",
              valve: 1,
              duration: phase.duration,
              temperature: phase.temperature || profileData.temperature,
              transition: phase.transition || {
                type: "linear",
                duration: Math.min(phase.duration, 2),
                adaptive: true,
              },
              pump: phase.pump || {
                target: "pressure",
                pressure: 9,
                flow: 0,
              },
              targets: phase.targets || [],
            })),
          };
          
          // Send save request
          const saveRequest = {
            tp: "req:profiles:save",
            rid: saveRequestId,
            profile: profileToSave,
          };
          ws.send(JSON.stringify(saveRequest));
        }
        
        // Handle save response
        if (response.tp === "res:profiles:save" && response.rid === saveRequestId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            
            if (response.error) {
              reject(new Error(`Failed to save AI Profile: ${response.error}`));
            } else {
              resolve(response.profile || { success: true });
            }
          }
        }
      } catch (error) {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Failed to parse response: ${error}`));
        }
      }
    });

    ws.on("error", (error) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`WebSocket error: ${error.message}`));
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        reject(new Error(`WebSocket closed unexpectedly`));
      }
    });
  });
}

// Fetch shot notes from Gaggimate WebSocket API
async function fetchShotNotesFromGaggimate(shotId: string): Promise<any | null> {
  return new Promise((resolve) => {
    const WEBSOCKET_URL = `${GAGGIMATE_PROTOCOL}://${GAGGIMATE_HOST}/ws`;
    const ws = new WebSocket(WEBSOCKET_URL);
    const requestId = generateRequestId();
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    // Shorter timeout for notes - don't block the main request
    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null); // Return null on timeout, don't fail the whole request
      }
    }, REQUEST_TIMEOUT);

    ws.on("open", () => {
      const request = {
        tp: "req:history:notes:get",
        rid: requestId,
        id: shotId, // Use unpadded ID
      };
      ws.send(JSON.stringify(request));
    });

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.tp === "res:history:notes:get" && response.rid === requestId) {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(response.notes || null);
          }
        }
      } catch (error) {
        // Ignore parse errors for other messages (like evt:status)
      }
    });

    ws.on("error", () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(null); // Return null on error, don't fail
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        resolved = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(null);
      }
    });
  });
}

// Fetch shot history from Gaggimate HTTP API
async function fetchShotHistoryFromGaggimate(limit?: number, offset?: number): Promise<any[]> {
  try {
    const url = `${HTTP_PROTOCOL}://${GAGGIMATE_HOST}/api/history/index.bin`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Index doesn't exist, return empty list
        console.log('Shot index not found. Empty history.');
        return [];
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const indexData = parseBinaryIndex(buffer);
    const shotList = indexToShotList(indexData);

    // Apply limit and offset if provided
    let result = shotList;
    if (offset !== undefined && offset > 0) {
      result = result.slice(offset);
    }
    if (limit !== undefined && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout: No response from Gaggimate at ${GAGGIMATE_HOST}`);
    }
    throw error;
  }
}

// Fetch a specific shot by ID from Gaggimate HTTP API
async function fetchShotFromGaggimate(shotId: string): Promise<any> {
  try {
    // Pad ID to 6 digits with zeros to match backend filename format
    const paddedId = shotId.padStart(6, '0');
    const url = `${HTTP_PROTOCOL}://${GAGGIMATE_HOST}/api/history/${paddedId}.slog`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/octet-stream',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // Shot not found
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const shotData = parseBinaryShot(buffer, shotId);

    return shotData;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout: No response from Gaggimate at ${GAGGIMATE_HOST}`);
    }
    throw error;
  }
}

// Create MCP server
const server = new Server(
  {
    name: "gaggimate-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
const TOOLS: Tool[] = [
  {
    name: "list_profiles",
    description: "List all available brewing profiles from Gaggimate device",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_profile",
    description: "Get a specific brewing profile by ID from Gaggimate device",
    inputSchema: {
      type: "object",
      properties: {
        profileId: {
          type: "string",
          description: "The ID of the profile to retrieve",
        },
      },
      required: ["profileId"],
    },
  },
  {
    name: "list_shot_history",
    description: "List brewing history (shots) from Gaggimate device",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of shots to retrieve (optional)",
        },
        offset: {
          type: "number",
          description: "Number of shots to skip from the beginning (optional)",
        },
      },
    },
  },
  {
    name: "get_shot",
    description: "Get detailed information about a specific shot by ID, including user notes (grind setting, bean type, dose, ratio, taste). Optionally includes full curve data with all sensor samples.",
    inputSchema: {
      type: "object",
      properties: {
        shotId: {
          type: "string",
          description: "The ID of the shot to retrieve",
        },
        includeFullCurve: {
          type: "boolean",
          description: "If true, includes all ~100 data points from the extraction curve (temperature, pressure, flow over time). Default: false (returns only 3 representative samples per phase).",
        },
      },
      required: ["shotId"],
    },
  },
  {
    name: "update_ai_profile",
    description: "Update or create the AI Profile for espresso brewing. This profile is specifically reserved for AI experimentation. Supports adaptive extraction with stop conditions (pressure, flow, weight, volume) for each phase.",
    inputSchema: {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Target water temperature in Celsius (typically 88-96°C)",
        },
        phases: {
          type: "array",
          description: "Array of brewing phases defining the extraction profile",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Phase name (e.g., 'Preinfusion', 'Extraction')",
              },
              phase: {
                type: "string",
                enum: ["preinfusion", "brew"],
                description: "Phase type",
              },
              duration: {
                type: "number",
                description: "Duration in seconds",
              },
              temperature: {
                type: "number",
                description: "Temperature for this phase in Celsius",
              },
              pump: {
                type: "object",
                description: "Pump settings for this phase",
                properties: {
                  target: {
                    type: "string",
                    enum: ["pressure", "flow"],
                  },
                  pressure: {
                    type: "number",
                    description: "Pressure in bar",
                  },
                  flow: {
                    type: "number",
                    description: "Flow rate in ml/s",
                  },
                },
              },
              transition: {
                type: "object",
                description: "Transition settings",
                properties: {
                  type: {
                    type: "string",
                    enum: ["linear", "ease-out", "ease-in", "instant"],
                  },
                  duration: {
                    type: "number",
                    description: "Transition duration in seconds",
                  },
                },
              },
              targets: {
                type: "array",
                description: "Stop conditions for this phase. Phase stops when ANY condition is met or duration expires",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["pressure", "flow", "volumetric", "pumped"],
                      description: "Type of stop condition",
                    },
                    operator: {
                      type: "string",
                      enum: ["gte", "lte"],
                      description: "Comparison operator (gte = >=, lte = <=)",
                    },
                    value: {
                      type: "number",
                      description: "Threshold value (bar for pressure, ml/s for flow, g for volumetric, ml for pumped)",
                    },
                  },
                  required: ["type", "value"],
                },
              },
            },
            required: ["name", "phase", "duration"],
          },
        },
      },
      required: ["temperature", "phases"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_profiles": {
        try {
          const profiles = await fetchProfilesFromGaggimate();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  profiles: profiles,
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        } catch (error) {
          // Return error but still as valid response
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  profiles: [],
                  error: error instanceof Error ? error.message : "Failed to fetch profiles",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        }
      }

      case "get_profile": {
        try {
          const profileId = args?.profileId as string;
          if (!profileId) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: "profileId is required",
                    code: "MISSING_PARAMETER",
                  }),
                },
              ],
            };
          }

          const profile = await fetchProfileFromGaggimate(profileId);
          if (!profile) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: `Profile with ID '${profileId}' not found`,
                    code: "PROFILE_NOT_FOUND",
                  }),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  profile: profile,
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        } catch (error) {
          // Return error but still as valid response
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : "Failed to fetch profile",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        }
      }

      case "list_shot_history": {
        try {
          const limit = args?.limit as number | undefined;
          const offset = args?.offset as number | undefined;
          
          const shots = await fetchShotHistoryFromGaggimate(limit, offset);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  shots: shots,
                  count: shots.length,
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        } catch (error) {
          // Return error but still as valid response
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  shots: [],
                  error: error instanceof Error ? error.message : "Failed to fetch shot history",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        }
      }

      case "get_shot": {
        try {
          const shotId = args?.shotId as string;
          const includeFullCurve = args?.includeFullCurve as boolean || false;

          if (!shotId) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: "shotId is required",
                    code: "MISSING_PARAMETER",
                  }),
                },
              ],
            };
          }

          // Fetch shot data and notes in parallel
          const [shot, notes] = await Promise.all([
            fetchShotFromGaggimate(shotId),
            fetchShotNotesFromGaggimate(shotId),
          ]);

          if (!shot) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: `Shot with ID '${shotId}' not found`,
                    code: "SHOT_NOT_FOUND",
                  }),
                },
              ],
            };
          }

          // Transform shot data to AI-friendly format
          const transformedShot = transformShotForAI(shot, includeFullCurve);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  shot: transformedShot,
                  notes: notes,
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        } catch (error) {
          // Return error but still as valid response
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : "Failed to fetch shot",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        }
      }

      case "update_ai_profile": {
        try {
          const temperature = args?.temperature as number;
          const phases = args?.phases as any[];
          
          if (!temperature || !Array.isArray(phases) || phases.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: "Temperature and phases array are required",
                    code: "MISSING_PARAMETERS",
                  }),
                },
              ],
            };
          }
          
          // Validate temperature range
          if (temperature < 60 || temperature > 100) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: true,
                    message: "Temperature must be between 60 and 100°C",
                    code: "INVALID_TEMPERATURE",
                  }),
                },
              ],
            };
          }
          
          // Validate phases
          for (const phase of phases) {
            if (!phase.name || !phase.phase || !phase.duration) {
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: true,
                      message: "Each phase must have name, phase type, and duration",
                      code: "INVALID_PHASE",
                    }),
                  },
                ],
              };
            }
          }
          
          const updatedProfile = await updateOrCreateAIProfile({ temperature, phases });
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  profile: updatedProfile,
                  message: updatedProfile.id ? "AI Profile updated successfully" : "AI Profile created successfully",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: error instanceof Error ? error.message : "Failed to update AI Profile",
                  source: GAGGIMATE_HOST,
                }),
              },
            ],
          };
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: `Unknown tool: ${name}`,
                code: "UNKNOWN_TOOL",
              }),
            },
          ],
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: true,
            message: error instanceof Error ? error.message : "An error occurred",
            code: "EXECUTION_ERROR",
          }),
        },
      ],
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Gaggimate MCP server running (connecting to ${GAGGIMATE_PROTOCOL}://${GAGGIMATE_HOST}/ws)`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});