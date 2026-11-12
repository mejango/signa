# Keep Signa simple

Apply [Ponytail](https://github.com/DietrichGebert/ponytail/blob/974d940a1c5344210874150b98ff0d2c861fab6a/skills/ponytail/SKILL.md) when changing or reviewing this repository.

- Read the affected journey and its callers before changing it. Fix the shared cause.
- Build what the user needs now. Reuse existing code, standard libraries, native HTML and installed dependencies before adding anything.
- Prefer removing steps and code over adding abstractions, configuration or frameworks. Keep advanced options out of the ordinary path with native controls.
- Fresh owner approval is the default for transactions. Bot API access and optional delegated wallet authority are separate.
- Preserve trust-boundary validation, exact reviewed transaction bytes, fresh approval, replay protection, canonical evidence, recovery and accessibility. Fewer prompts must never mean broader authority.
- Keep V6 coverage and requested user journeys complete. A missing observation is unknown, never success, zero or permission.
- Keep production claims tied to evidence: configured, simulated, submitted and canonically verified are different states.
- Add meaningful checks for changed behavior and run the repository release checks before shipping. Do not add dependencies or test scaffolding for trivial presentation changes.
- Never use middots. Keep the interface monospaced, square and responsive.

This guidance persists for future work. User instructions take precedence.
