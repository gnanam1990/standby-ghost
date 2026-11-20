/** Ordered, append-only schema migrations. Never edit an applied entry. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE productions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE script_revisions (
        id TEXT PRIMARY KEY,
        production_id TEXT NOT NULL REFERENCES productions(id),
        parent_id TEXT REFERENCES script_revisions(id),
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        digest TEXT NOT NULL,
        source_csv TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (production_id, seq)
      );

      CREATE TABLE cues (
        revision_id TEXT NOT NULL REFERENCES script_revisions(id) ON DELETE CASCADE,
        cue_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        label TEXT NOT NULL,
        deps_json TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (revision_id, cue_id)
      );
    `,
  },
];
MIGRATIONS.push({
  version: 2,
  sql: `
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL REFERENCES productions(id),
      script_revision_id TEXT NOT NULL REFERENCES script_revisions(id),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE invitations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE memberships (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      generation INTEGER NOT NULL,
      session_token_hash TEXT NOT NULL UNIQUE,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE takes (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      script_revision_id TEXT NOT NULL REFERENCES script_revisions(id),
      status TEXT NOT NULL DEFAULT 'active',
      epoch INTEGER NOT NULL DEFAULT 1,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES memberships(id),
      created_at TEXT NOT NULL,
      sealed_at TEXT
    );

    CREATE TABLE events (
      take_id TEXT NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      member_id TEXT NOT NULL REFERENCES memberships(id),
      cue_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (take_id, seq),
      UNIQUE (take_id, member_id, command_id)
    );
  `,
});
