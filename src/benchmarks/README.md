# Benchmarks

Benchmark dataset adapters. Each benchmark implements the `Benchmark` interface.

## Interface

```typescript
interface Benchmark {
    name: string
    load(config?: BenchmarkConfig): Promise<void>
    getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
    getHaystackSessions(questionId: string): UnifiedSession[]
    getGroundTruth(questionId: string): string
    getQuestionTypes(): QuestionTypeRegistry
}
```

## Adding a Benchmark

1. Create `src/benchmarks/mybenchmark/index.ts`
2. Implement `Benchmark` interface
3. Register in `src/benchmarks/index.ts`
4. Add to `BenchmarkName` type in `src/types/benchmark.ts`

**Required returns:**
- `load()` - Parse data, populate internal maps
- `getQuestions()` - Return `UnifiedQuestion[]` with filtering support
- `getHaystackSessions()` - Return `UnifiedSession[]` for a question
- `getGroundTruth()` - Return expected answer string
- `getQuestionTypes()` - Return `{ [id]: { id, alias, description } }`

## Existing Benchmarks

| Benchmark | Source | Description |
|-----------|--------|-------------|
| `locomo` | GitHub snap-research/locomo | Long context memory benchmark |
| `longmemeval` | HuggingFace xiaowu0162/longmemeval-cleaned | Long-term memory evaluation |
| `convomem` | HuggingFace Salesforce/ConvoMem | Conversational memory benchmark |
| `beam128k` | GitHub mohammadtavakoli78/BEAM `chats/100K` | BEAM 128K tier: 20 conversations, 10 memory abilities (arXiv:2510.27246) |

## Question Types

### LoCoMo
| Type | Alias | Description |
|------|-------|-------------|
| `single-hop` | single | Single-hop fact recall |
| `multi-hop` | multi | Multi-hop reasoning |
| `temporal` | temporal | Temporal reasoning |
| `world-knowledge` | world | Commonsense knowledge |
| `adversarial` | adversarial | Unanswerable questions |

### LongMemEval
| Type | Alias | Description |
|------|-------|-------------|
| `single-session-user` | ss-user | Single-session user facts |
| `single-session-assistant` | ss-asst | Single-session assistant facts |
| `single-session-preference` | ss-pref | Single-session preferences |
| `multi-session` | multi | Multi-session reasoning |
| `temporal-reasoning` | temporal | Temporal reasoning |
| `knowledge-update` | update | Knowledge update tracking |

### ConvoMem
| Type | Alias | Description |
|------|-------|-------------|
| `user_evidence` | user | User-stated facts |
| `assistant_facts_evidence` | asst | Assistant-stated facts |
| `preference_evidence` | pref | User preferences |
| `changing_evidence` | change | Information updates |
| `implicit_connection_evidence` | implicit | Implicit reasoning |
| `abstention_evidence` | abstain | Unanswerable questions |

### BEAM 128K
One conversation carries 20 probing questions (10 abilities x 2). Every question of a conversation names the same `haystackId`, so the harness ingests the conversation once and probes it 20 times (`src/orchestrator/haystack.ts`). Questions are ordered conversation-major: `-l 60` is exactly the first 3 conversations.

| Type | Alias | Description |
|------|-------|-------------|
| `abstention` | abstain | Withholds when evidence is missing |
| `contradiction_resolution` | contra | Detects and reconciles inconsistent statements |
| `event_ordering` | order | Reconstructs the sequence of events |
| `information_extraction` | extract | Recalls entities and facts |
| `instruction_following` | instruct | Sustains user-specified constraints |
| `knowledge_update` | update | Revises facts as new ones appear |
| `multi_session_reasoning` | multi | Integrates evidence across non-adjacent segments |
| `preference_following` | pref | Adapts to evolving preferences |
| `summarization` | summ | Abstracts and compresses dialogue |
| `temporal_reasoning` | temporal | Reasons about time relations |
