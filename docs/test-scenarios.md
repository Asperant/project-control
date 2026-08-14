# Test scenarios

Critical roadmap scenarios:

- anonymous read/write is rejected; viewer write is rejected;
- milestone/task CRUD, dense move up/down, boundary moves, and lifecycle dates;
- blocked status requires a reason;
- unfinished acceptance and dependency confirmations are server-counted and audited;
- self, duplicate, cross-project, and A→B→C→A dependencies are rejected;
- cancelled tasks do not affect progress; zero tasks reports `0 / 0`, `0%`;
- notes/description/next action/block reason content is absent from audit metadata;
- archived project and archived/cancelled milestone mutations are rejected;
- audit failure rolls the corresponding mutation back;
- backup/restore preserves all roadmap tables and relationships;
- project registration/rescan/archive, runner security, role isolation, and
  existing web/API flows remain green.
