# Elnuva

**Constraint-aware room planning, with you in control.**

Elnuva is being developed for The WebMCP Challenge. It addresses a practical problem: furniture can fit inside a room yet still block a doorway, crowd a radiator, or conflict with a person’s preferences. The project’s thesis is that precise room geometry and deterministic constraint checks can help a person compare layouts while keeping final control.

## Planned collaboration model

The planned human-agent workflow is:

1. **Inspect** — the agent reads the current semantic room layout.
2. **Validate** — the agent proposes one to three concrete move sets for Elnuva to check and rank deterministically.
3. **Stage** — the agent stages one validated option as an ephemeral preview.

Applying, discarding, and saving remain visible human actions.

## Planned stack

- Vanilla TypeScript
- Vite
- Static Netlify hosting
- No application runtime dependencies, backend, or external AI API

## Status

implementation in progress

## License

Licensed under the [MIT License](LICENSE).
