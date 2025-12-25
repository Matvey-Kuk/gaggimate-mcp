# Gaggimate MCP Server

MCP server for Gaggimate espresso machine profiles.

## Quick Start

```bash
GAGGIMATE_HOST=192.168.1.100 npx -y matvey-kuk/gaggimate-mcp
```

## Environment Variables

- `GAGGIMATE_HOST`: Device hostname (default: `localhost`)
- `GAGGIMATE_PROTOCOL`: WebSocket protocol `ws` or `wss` (default: `ws`)

## Tools

- `list_profiles`: List all brewing profiles
- `get_profile`: Get a specific profile by ID
- `update_ai_profile`: Update or create the AI Profile for espresso brewing (supports adaptive extraction with stop conditions)
- `list_shot_history`: List brewing history (with optional limit/offset)
- `get_shot`: Get detailed information about a specific shot by ID

## Docker

```bash
# Build
npm run build
docker build -t gaggimate-mcp .

# Run with default settings
docker run gaggimate-mcp

# Run with custom host
docker run -e GAGGIMATE_HOST=192.168.1.100 gaggimate-mcp
```