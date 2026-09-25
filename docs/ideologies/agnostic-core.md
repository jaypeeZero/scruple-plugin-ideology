
# Agnostic Core, Specific Edges

Your core business logic should be infrastructure-agnostic. The "edges" of your application handle specifics.

## The Pattern

```
┌──────────────────────────────────────────────────────────────┐
│                         EDGES (IN)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ HTTP Handler │  │  Pub/Sub     │  │  CLI Command │       │
│  │              │  │  Subscriber  │  │              │       │
│  │ JSON →       │  │ message →    │  │ args →       │       │
│  │ domain       │  │ domain       │  │ domain       │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │               │
│         ▼                 ▼                 ▼               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                     CORE                             │   │
│  │                                                      │   │
│  │              Business Logic                          │   │
│  │         (speaks only domain language)                │   │
│  │                                                      │   │
│  └───────┬──────────────────────────────┬───────────┘   │
│          │                              │               │
│          ▼                              ▼               │
│  ┌──────────────┐              ┌──────────────┐         │
│  │  Database    │              │  API Client  │         │
│  │  Repository  │              │              │         │
│  │              │              │  string →    │         │
│  │  SQL →       │              │  boolean     │         │
│  │  domain      │              │              │         │
│  └──────────────┘              └──────────────┘         │
│                        EDGES (OUT)                       │
└──────────────────────────────────────────────────────────┘
```

## Example: A Repository

Edges handle infrastructure. The service owns business logic — both orchestration and transformation.

```python
# repository.py - EDGE (database-specific)
class UserRepository:
    def find_by_id(self, id):
        row = db.query("SELECT * FROM users WHERE id = %s", [id])
        return self._to_domain(row) if row else None

    def save(self, user):
        db.execute("UPDATE users SET status = %s WHERE id = %s",
            ["A" if user.is_active else "I", user.id])

    def _to_domain(self, row):
        return User(
            id=row.id,
            name=row.full_name,            # DB column name → domain name
            is_active=row.status == "A",    # DB code → boolean
        )

# service.py - CORE (business logic)
class UserService:
    def __init__(self, user_repo):
        self.user_repo = user_repo

    def deactivate(self, user_id):
        user = self.user_repo.find_by_id(user_id)
        if not user:           raise NotFoundError()
        if not user.is_active: return user
        updated = User(**user, is_active=False)
        self.user_repo.save(updated)
        return updated

# handler.py - EDGE (protocol translation)
@route("POST /users/:id/deactivate")
def deactivate_user(request):
    try:
        user = user_service.deactivate(request.params.id)
        return 200, user
    except NotFoundError:
        return 404
```

## Translate at Boundaries

External data formats should be translated at the edge, not in business code.

```python
# api_client.py - EDGE (incoming)
class ExternalApiClient:
    def get_feature_flags(self):
        response = fetch("/api/flags")
        data = response.json()

        # External API sends strings, we use booleans
        return FeatureFlags(
            dark_mode=data["dark_mode"] == "true",
            beta_features=data["beta"] == "1",
        )

# feature_service.py - CORE
class FeatureService:
    # Never sees strings - only typed booleans
    def is_enabled(self, flags, feature):
        return getattr(flags, feature)
```

## Backing Services as Attached Resources

Databases, message queues, caches, external APIs — treat them all the same way. They're resources your app attaches to via configuration.

```
┌─────────────┐
│    App      │
└──┬──┬──┬──┬─┘
   │  │  │  │
   ▼  ▼  ▼  ▼
  DB MQ S3 API

  All accessed via URL/credentials in config
```

**The principle:** Swap any service by changing config, no code changes.

```bash
# Switch from local to managed database
DATABASE_URL=postgres://localhost/myapp          # local
DATABASE_URL=postgres://user:pass@rds.aws/myapp  # production
```

This is agnostic core applied to infrastructure: your app doesn't know or care whether its database is local, managed, or in another continent.

## Why This Matters

- **Testability**: Core logic can be tested without databases, APIs, or external systems
- **Flexibility**: Swap PostgreSQL for MongoDB? Only change the repository
- **Portability**: Swap any backing service by changing config alone
- **Clarity**: Business rules aren't buried in data transformation code
- **Maintenance**: External API changes don't ripple through your codebase

## Draw Consistency Boundaries

Identify the smallest groups of things that must change together, and enforce rules at those boundaries. Not everything in the system needs to be consistent with everything else — only things within the same boundary do.

## Scope Your Models

A single unified model breaks at scale. Give each bounded context its own model. The same concept (e.g. a "user") can and should look different depending on which part of the system is working with it.

## External Dependencies Are Only Up Half the Time

Failures from external services are the normal path, not edge cases. Design for degraded states, timeouts, and partial failures as first-class concerns rather than exceptional ones.
