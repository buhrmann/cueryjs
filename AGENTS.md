# Cuery - Development Guide

## Overview

Cuery is a TypeScript/Deno library providing LLM-powered tools for generating structured marketing data. It supports multiple LLM providers (OpenAI, Gemini, Anthropic) with Zod schema validation for type-safe, predictable outputs.

## Commands

```bash
# Run all tests (skip OpenAI tests by default)
deno task test

# Run tests including OpenAI integration tests
RUN_OPENAI_TESTS=1 deno task test

# Run specific test file
deno test tests/brands.test.ts --allow-env --allow-net --env-file

# Type check
deno task check
# or
deno check mod.ts

# Run examples
deno task run examples/example.ts
```

## Project Structure

```
cueryjs/
├── mod.ts                      # Main entry point - exports public API
├── deno.json                   # Deno configuration and tasks
├── src/
│   ├── async.ts                # Async utilities (mapParallel, withRetries, sleep)
│   ├── llm.ts                  # Provider-agnostic LLM interface
│   ├── batch-response.ts       # BatchResponse class with usage tracking
│   ├── providers/              # LLM provider implementations
│   │   ├── index.ts            # Provider registry and Model factory
│   │   ├── openai.ts           # OpenAI provider
│   │   ├── gemini.ts           # Google Gemini provider
│   │   ├── anthropic.ts        # Anthropic Claude provider
│   │   ├── model.ts            # Model interface and factory
│   │   └── pricing.ts          # Model pricing lookup
│   ├── assets/
│   │   └── models.json         # Pricing data from models.dev
│   ├── urls.ts                 # URL manipulation utilities
│   ├── utils.ts                # General utilities
│   ├── schemas/                # Zod schemas for all data types
│   │   ├── index.ts
│   │   ├── brand.schema.ts
│   │   ├── funnel.schema.ts
│   │   ├── persona.schema.ts
│   │   ├── sources.schema.ts
│   │   └── ...
│   ├── tools/                  # LLM-powered analysis tools
│   │   ├── brands.ts           # Brand detection and competitor analysis
│   │   ├── classifier.ts       # Text classification
│   │   ├── entities.ts         # Entity extraction
│   │   ├── funnel.ts           # Marketing funnel customization
│   │   ├── keywords.ts         # Keyword generation
│   │   ├── personas.ts         # Customer persona generation
│   │   ├── scorer.ts           # Content scoring
│   │   ├── search.ts           # Web search with structured results
│   │   ├── seedKeywords.ts     # Seed keyword generation
│   │   ├── sentiment.ts        # Sentiment analysis
│   │   ├── sourceLinker.ts     # Source URL linking
│   │   ├── sources.ts          # Source enrichment and ranking
│   │   ├── topics.ts           # Topic extraction and assignment
│   │   └── translate.ts        # Translation utilities
│   └── apis/                   # External API integrations
│       ├── autocomplete.ts     # Search autocomplete
│       ├── hasdata/            # HasData SERP API
│       ├── chatgptScraper/     # ChatGPT scraper integration
│       └── brightdata/         # BrightData proxy integration
├── tests/                      # Test files
└── examples/                   # Usage examples
```

## Key Concepts

### LLM Integration

All LLM calls go through `src/llm.ts` which provides:
- `askLLM()` - Direct LLM call with Zod schema validation
- `askLLMSafe()` - Wrapped version with retry logic and error handling

Supports multiple providers (OpenAI, Gemini, Anthropic) via the `src/providers/` module:
- `getProviderForModel('gpt-4.1')` - Get provider instance for a model (`gemini-*` → Google, `claude-*` → Anthropic, anything else → OpenAI)
- `getModelPricing('gpt-4.1')` - Get model pricing info (the model's own provider's price from models.dev; run `deno task update-models` to refresh)
- `calculateCost('gpt-4.1', usage)` - Calculate cost from token usage; cached and cache-write input tokens are charged at their own rates

`TokenUsage.inputTokens` is the whole prompt and `outputTokens` all generated tokens, including reasoning/thinking. `cachedInputTokens`, `cacheWriteTokens` and `reasoningTokens` break them down when the provider reports them.

### Schemas

All data structures are defined as Zod schemas in `src/schemas/`. This ensures:
- Type safety at compile time
- Runtime validation of LLM responses
- Self-documenting API

### Tools vs Utilities

- **Tools** (`src/tools/`): LLM-powered functions that make LLM calls
- **Utilities** (`src/`): Pure functions for data manipulation, no LLM calls

### Import Patterns

From tools:
```typescript
import { mapParallel } from '../async.ts';
import { askLLMSafe } from '../llm.ts';
import { searchWithFormat } from './search.ts';  // inter-tool import
```

From mod.ts:
```typescript
export * from './src/tools/keywords.ts';
export * from './src/schemas/index.ts';
```

## Testing

Tests use Deno's built-in test runner with `@std/assert`.

OpenAI integration tests are skipped by default:
```typescript
const SKIP_OPENAI = !Deno.env.get('RUN_OPENAI_TESTS');

Deno.test({
    name: 'test name',
    ignore: SKIP_OPENAI,
    async fn() { ... }
});
```

Run with OpenAI tests: `RUN_OPENAI_TESTS=1 deno task test`

## Environment Variables

- `OPENAI_API_KEY` - Required for OpenAI models
- `GOOGLE_API_KEY` or `GEMINI_API_KEY` - Required for Gemini models
- `ANTHROPIC_API_KEY` - Required for Claude models
- `RUN_OPENAI_TESTS` - Set to run integration tests

## Dependencies

- `@openai/openai` - OpenAI API client
- `@google/genai` - Google Gemini API client
- `@anthropic-ai/sdk` - Anthropic (Claude) API client
- `@zod/zod` - Schema validation (Zod 4)
- `@std/assert` - Deno standard library assertions

## API Reference

### Persona Generation

```typescript
import { generatePersonas } from "@graphext/cuery";

const result = await generatePersonas({
    sector: 'Running Shoes',
    market: 'Spain',
    brand: 'Nike',
    language: 'spanish'
});
// { personas: [{ name: string, description: string }, ...] }
```

### Marketing Funnel

```typescript
import { customizeFunnel } from "@graphext/cuery";

const funnel = await customizeFunnel(
    'E-commerce Fashion',  // sector
    'English',             // language
    'United States',       // country
    'gpt-4.1'             // model
);
```

### Keyword Generation

```typescript
import { generateKeywords } from "@graphext/cuery";

const result = await generateKeywords({
    sector: 'running shoes',
    market: 'Spain',
    brand: 'Nike',
    language: 'spanish',
    keywords: ['existing keyword'],  // optional - preserve these
    instructions: 'Focus on trail running'  // optional
});
```

### Brand Detection

```typescript
import { enrichSource, rankBrandsInSourceArray } from "@graphext/cuery";

const enriched = enrichSource(source, brands, entities);
const ranked = rankBrandsInSourceArray(enrichedSources);
```

### Topic Classification

```typescript
import { assignTopic, extractTopics, createLabelSchema } from "@graphext/cuery";

const taxonomy = { topics: [{ topic: 'Tech', subtopics: ['AI', 'Cloud'] }] };
const labelSchema = createLabelSchema(taxonomy);
const result = await assignTopic(text, taxonomy, labelSchema);
```

## Edge Functions

Can be deployed as Supabase edge functions:

1. Run `supabase start`
2. Deploy function
3. Call via HTTP:
```bash
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/function_name' \
    --header 'Authorization: Bearer <token>' \
    --header 'Content-Type: application/json' \
    --data '{"param": "value"}'
```

## Releasing

A push to `main` that changes `version` in `deno.json` publishes to JSR and npm (`.github/workflows/release.yml`).
Prepare it with:

```bash
deno task release:prepare 0.13.0   # refresh pricing from models.dev, print what changed, set the version
deno task check && deno task test
git add deno.json src/assets/models.json && git commit -m "Release 0.13.0"
```

The pricing in `src/assets/models.json` is a snapshot of models.dev (`deno task update-models`), bundled so
`getModelPricing` and `calculateCost` work offline. Review the printed changes before committing: models.dev is a
community dataset (check a surprising price against the provider's own page). The release workflow fetches
models.dev again and warns when the committed snapshot is already behind, but publishes the committed one.
`deno task pricing:diff` shows the uncommitted pricing changes at any time.
