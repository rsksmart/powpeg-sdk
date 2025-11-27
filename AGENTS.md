# Context for AI coding agents

## Commands
- `pnpm lint` - Check for linting issues.
- `pnpm lint:fix` - Fix auto-fixable issues.
- `pnpm test` - Run all tests.
- `pnpm test -- -t <suite_name>` - Run specific test suite.
- `pnpm build` - Build the project.

## Code style guidelines
- Prefer descriptive, readable names over short, cryptic abbreviations. Follow existing domain vocabulary for consistency.
- Only add comments for non-obvious behavior or workarounds.
- Do not add `eslint-disable` comments to bypass linter errors.
- Do not add `@ts-ignore` comments to bypass type errors.

## TypeScript features
- Do not introduce new enums into the codebase. Retain existing enums. If you require enum-like behaviour, use an `as const` object.
- Use discriminated unions to model data with mutually exclusive states and make invalid states unrepresentable.
- Use optional properties extremely sparingly. Only use them when the property is truly optional, and consider whether bugs may be caused by a failure to pass the property.

## Testing instructions
- Do not assert implementation details. A test must fail if, and only if, the intention behind the system is not met.
- Never mock anything directly related to the tested intention. Try to introduce mocks at the lowest level possible.
