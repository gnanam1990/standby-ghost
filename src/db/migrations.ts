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
