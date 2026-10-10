# Working agreement

- Implement in small, reviewable milestones. Stop after each milestone, summarize the changes and verification, and wait for the user to inspect and commit before continuing.
- Do not automatically stage, commit, or push changes. Preserve the user's staged and uncommitted work.
- Keep each milestone focused. Do not combine collection, decoding, rendering, and inference into one review.

# Architecture

- Use cohesive classes with explicit methods for components that own state, configuration, resources, or replaceable behavior. Use small pure functions for stateless transformations; avoid both giant orchestrator classes and unnecessary class hierarchies.
- Keep provider access, metadata resolution, decoding, evidence normalization, compression, rendering, and inference behind clear interfaces. Inject dependencies rather than hard-coding clients or global state.
- Make the orchestrator coordinate components; keep domain logic in the responsible component.
- Maintain one typed, versioned execution representation shared by YAML and image generation. Preserve raw evidence and provenance separately from presentation.
- Prefer composition and explicit data contracts. Add extension points for real requirements, without speculative frameworks or abstraction layers.
- Use names and types that explain intent. Add comments only for non-obvious reasoning, constraints, or correctness requirements. Avoid comments that restate code and excessive method docstrings.
- Keep ABI and storage decoding generic. Put standard token semantics in a separate interpretation layer. Contract-specific interpretation must use explicitly configured adapters scoped by chain and contract address; do not add protocol/address/name/selector exceptions to the generic decoder.
- Keep interpreted asset movements and selected state changes linked to their supporting evidence. Distinguish reported events, observed net state changes, and inferred movements. Do not turn an attempted call or an arbitrary numeric storage change into a confirmed asset transfer.
