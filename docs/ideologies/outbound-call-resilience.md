# Outbound Call Resilience

Failures from external services are the normal path, not an edge case. Design for slow, down, and partial.

## Principles

- **Bound every call** - No outbound call waits forever; use a timeout or deadline
- **Choose degradation deliberately** - Decide what happens when a dependency fails: retry, fall back, or fail loudly
- **Policy lives at the edge** - Timeouts and retries are configuration, not constants buried in business logic
