# OLLAMACODE

Local-first terminal coding agent that runs against local models (Ollama, HuggingFace).

## Commands

- **Run**: `npm start`
- **Test**: `npm test`
- **Lint**: `npm run lint`
- **Typecheck**: `npm run typecheck`
- **Build WASM**: `npm run build:wasm`
- **Init**: `npm run init`

## Architecture

The project is structured into several specialized modules under `src/`:

- `agent/`: Core agent logic and tool implementations.
- `cli/`: Command-line interface entry points and argument parsing.
- `context/`: Management of the agent's conversation and project context.
- `core/`: Fundamental logic and shared utilities.
- `env/`: Environment configuration and management.
- `mcp/`: Model Context Protocol implementations.
- `model/`: LLM integration and model-specific configurations.
- `prompts/`: System prompts and template management.
- `protocol/`: Communication protocols and message formats.
- `ui/`: Terminal user interface components (powered by Ink).

## Conventions

- **Language**: TypeScript.
- **UI Framework**: React-based terminal UI using `ink`.
- **Linting**: Uses `oxlint` for fast linting.
- **Type Checking**: Strict type checking via `tsc --noEmit`.
- **WASM**: Includes a WebAssembly-powered core developed with AssemblyScript (`wasm-src/`).
