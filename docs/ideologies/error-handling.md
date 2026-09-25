
# Error Handling

Errors should bubble up. Handle them at the highest layer, not scattered throughout the codebase.

```
    ┌─────────────────────────────────────────┐
    │            TOP LAYER                    │  ← Handle errors HERE
    │         (entry point)                   │
    │                                         │
    │   try:                                  │
    │     process_request(req)                │
    │   except Exception as e:               │
    │     log_error(e)                        │
    │     return error_response(e)            │
    │                                         │
    └───────────────┬─────────────────────────┘
                    │
                    ▼
    ┌─────────────────────────────────────────┐
    │          MIDDLE LAYERS                  │  ← Let errors propagate
    │                                         │
    │   # No try/except here                  │
    │   user = get_user(id)                   │
    │   result = process(user)                │
    │   return result                         │
    │                                         │
    └───────────────┬─────────────────────────┘
                    │
                    ▼
    ┌─────────────────────────────────────────┐
    │           LEAF LAYERS                   │  ← Raise meaningful errors
    │                                         │
    │   if not row: raise NotFoundError()     │
    │                                         │
    └─────────────────────────────────────────┘
```

## Principles

- **Handle errors at the top** - Entry points (HTTP handlers, CLI commands, event handlers) are where errors become responses
- **Let errors propagate** - Middle layers should not catch errors unless they can meaningfully recover
- **Only catch when necessary** - Catch an error only if subsequent code can still run safely after the error occurred
- **Warnings are unresolved errors** - Treat them that way

## When Catching is Appropriate

```python
# ✓ Subsequent code can still run - partial failure is acceptable
def validate(item):
    try:    return check_rule(item)
    except Exception as e: return {"item": item, "error": str(e)}

def validate_all(items):
    return [validate(item) for item in items]

# ✓ Resource cleanup that must happen
def with_connection(fn):
    conn = connect()
    try:
        return fn(conn)
    finally:
        conn.close()
```

## Anti-patterns

```python
# ✗ Catch-log-rethrow adds noise, not value
try:
    do_thing()
except Exception as e:
    print(f"Error in do_thing: {e}")
    raise

# ✗ Swallowing errors hides problems
try:
    do_thing()
except Exception:
    pass

# ✗ Defensive catching in middle layers
def get_user(id):
    try:
        return db.find_user(id)
    except Exception:
        return None  # Now caller can't distinguish "not found" from "database down"
```
